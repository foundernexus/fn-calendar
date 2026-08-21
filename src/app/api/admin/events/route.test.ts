import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, reinstallTestDb, type TestDb } from "@/test/db";
import {
  adminCookie,
  jsonRequest,
  mockCookies,
  seedMember,
  seedConnection,
  seedEvent,
} from "@/test/helpers";
import { events, eventAttendees } from "@/db/schema";
import { computeIdempotencyKey } from "@/lib/idempotency";

/** Booking is the one action that reaches outside the app: by the time
 * anything here can fail, real invites are already in real inboxes. These
 * tests cover the two ways that went wrong — a session saved with no
 * attendees, and a second booking silently doing nothing. */

let harness: TestDb;

/** Typed arguments, so a test can assert on what the route actually sent —
 * an untyped vi.fn() makes mock.calls opaque. */
type CreateArgs = { participants: { email: string; name?: string }[] };

const nylas = {
  createNylasEvent: vi.fn(async (_args: CreateArgs) => ({ eventId: "provider-event-1" })),
  cancelSessionEvent: vi.fn(async (_args: unknown) => ({ ok: true })),
  getCollectiveAvailability: vi.fn(async () => ({
    slots: [] as { startTime: number; endTime: number }[],
    unreadable: [] as string[],
  })),
};

vi.mock("@/lib/calendar/events", () => ({
  createSessionEvent: (args: CreateArgs) => nylas.createNylasEvent(args),
  // Used to take back a calendar event when the DB write that should have
  // recorded it fails — without it that event stays in everyone's diary with
  // nothing in the app able to reach it.
  cancelSessionEvent: (args: unknown) => nylas.cancelSessionEvent(args),
}));
vi.mock("@/lib/calendar/availability", () => ({
  getCollectiveAvailability: () => nylas.getCollectiveAvailability(),
}));

/** 10:00 Pacific on a Wednesday, on a 30-minute boundary like the grid emits. */
const SLOT = Math.floor(new Date("2026-09-02T17:00:00Z").getTime() / 1000);

beforeAll(async () => {
  harness = await createTestDb();
});
afterAll(async () => {
  await harness.close();
});
beforeEach(async () => {
  await harness.reset();
  vi.clearAllMocks();
  // Default: the slot is still free. Individual tests override.
  nylas.getCollectiveAvailability.mockResolvedValue({
    slots: [{ startTime: SLOT, endTime: SLOT + 3600 }],
    unreadable: [],
  });
  nylas.createNylasEvent.mockResolvedValue({ eventId: "provider-event-1" });
  vi.resetModules();
  mockCookies(await adminCookie());
  await reinstallTestDb();
});

async function seedCast() {
  const lead = await seedMember({ email: "tobias@foundernexus.com", isFacilitator: true });
  const advisor = await seedMember({ email: "court@foundernexus.com", isAdvisor: true });
  const founder = await seedMember({ email: "founder@example.com" });
  for (const m of [lead, advisor, founder]) {
    await seedConnection({ memberId: m.id, grantEmail: m.email, grantId: `g-${m.id}` });
  }
  return { lead, advisor, founder };
}

function body(cast: Awaited<ReturnType<typeof seedCast>>, over: Record<string, unknown> = {}) {
  return {
    organizerMemberId: cast.lead.id,
    advisorMemberId: cast.advisor.id,
    guestMemberIds: [cast.founder.id],
    title: "Expert session",
    startsAtUnix: SLOT,
    durationMinutes: 60,
    timezone: "America/Los_Angeles",
    ...over,
  };
}

async function post(payload: unknown) {
  const { POST } = await import("./route");
  return POST(
    jsonRequest("http://localhost/api/admin/events", payload, { cookie: await adminCookie() })
  );
}

describe("auth", () => {
  it("rejects a request with no admin session", async () => {
    vi.resetModules();
    mockCookies();
    await reinstallTestDb();
    const { POST } = await import("./route");
    const res = await POST(jsonRequest("http://localhost/api/admin/events", {}));
    expect(res.status).toBe(401);
  });
});

describe("writing the session", () => {
  it("saves the event AND every attendee", async () => {
    const cast = await seedCast();
    const res = await post(body(cast));
    expect(res.status).toBe(200);

    const [event] = await harness.db.select().from(events);
    const attendees = await harness.db
      .select()
      .from(eventAttendees)
      .where(eq(eventAttendees.eventId, event.id));

    // Lead, advisor and founder. A session that saved with no attendees showed
    // on nobody's dashboard, blocked nobody's removal, and could not be
    // rescheduled, because the idempotency key is rebuilt from this list.
    expect(attendees).toHaveLength(3);
    expect(attendees.find((a) => a.memberId === cast.advisor.id)!.role).toBe("advisor");
    // The connection it was created on is pinned, not re-derived later: an
    // event id only means anything against the calendar that issued it, so
    // cancelling has to go back to this exact row.
    expect(event.providerEventId).toBe("provider-event-1");
    expect(event.organizerConnectionId).not.toBeNull();
  });

  it("writes nothing at all when the attendee insert fails", async () => {
    const cast = await seedCast();
    // A member vanishing between the lookup and the insert trips the foreign
    // key on event_attendees — the failure this transaction exists for.
    await post(body(cast));
    await harness.reset();

    const cast2 = await seedCast();
    await harness.client.exec(
      `ALTER TABLE event_attendees ADD CONSTRAINT tmp_fail CHECK (member_id < 0)`
    );
    const res = await post(body(cast2));
    await harness.client.exec(`ALTER TABLE event_attendees DROP CONSTRAINT tmp_fail`);

    expect(res.status).toBe(500);
    // The event row must be gone too. Before this was one transaction, the
    // request returned 200 for a session with no attendees.
    expect(await harness.db.select().from(events)).toHaveLength(0);

    // And the calendar event has to be taken back. It was created before the
    // DB write, so at this point it is a real meeting sitting in the lead's,
    // the advisor's and the founder's diaries — with no row anywhere in the app
    // able to show, move or cancel it. Rolling back the database while leaving
    // that behind is not a rollback, it just moves the mess somewhere nobody
    // is looking.
    expect(nylas.cancelSessionEvent).toHaveBeenCalledTimes(1);
    expect(nylas.cancelSessionEvent.mock.calls[0]![0]).toMatchObject({
      providerEventId: "provider-event-1",
    });

    // Says which of the two actually happened: withdrawn means retry freely,
    // stuck means check the calendar first or book it twice.
    expect((await res.json()).error).toMatch(/withdrawn/i);
  });

  it("invites the connected calendar's address, not the registered one", async () => {
    const lead = await seedMember({ email: "tobias@foundernexus.com", isFacilitator: true });
    const founder = await seedMember({ email: "registered@work.com" });
    await seedConnection({ memberId: lead.id, grantEmail: lead.email, grantId: "g-lead" });
    await seedConnection({
      memberId: founder.id,
      grantEmail: "actually-used@gmail.com",
      grantId: "g-founder",
    });

    await post({
      organizerMemberId: lead.id,
      guestMemberIds: [founder.id],
      title: "x",
      startsAtUnix: SLOT,
      durationMinutes: 60,
      timezone: "America/Los_Angeles",
    });

    // Availability was checked against the connected calendar, so the invite
    // has to go there — the registered address may be a calendar nobody reads.
    const participants = nylas.createNylasEvent.mock.calls[0]![0].participants;
    expect(participants.map((p: { email: string }) => p.email)).toContain("actually-used@gmail.com");
  });
});

describe("duplicate protection", () => {
  it("returns the existing session rather than booking twice", async () => {
    const cast = await seedCast();
    await post(body(cast));
    const second = await post(body(cast));

    expect((await second.json()).alreadyExisted).toBe(true);
    expect(await harness.db.select().from(events)).toHaveLength(1);
    expect(nylas.createNylasEvent).toHaveBeenCalledTimes(1);
  });

  it("allows rebooking the same people at the same time after a cancellation", async () => {
    const cast = await seedCast();
    const key = await computeIdempotencyKey({
      guestMemberIds: [cast.founder.id],
      advisorMemberId: cast.advisor.id,
      startsAtUnix: SLOT,
      durationMinutes: 60,
    });
    // A cancelled session that kept its key made this return a cheerful 200
    // with alreadyExisted — no event, no invites, and a green toast.
    await seedEvent({
      organizerMemberId: cast.lead.id,
      idempotencyKey: `${key}|cancelled:1`,
      startsAt: new Date(SLOT * 1000),
      status: "cancelled",
    });

    const res = await post(body(cast));
    expect((await res.json()).alreadyExisted).toBe(false);
    expect(nylas.createNylasEvent).toHaveBeenCalledTimes(1);
  });
});

describe("guards", () => {
  it("refuses a slot that is no longer free", async () => {
    const cast = await seedCast();
    nylas.getCollectiveAvailability.mockResolvedValue({ slots: [], unreadable: [] });

    const res = await post(body(cast));

    expect(res.status).toBe(409);
    expect(nylas.createNylasEvent).not.toHaveBeenCalled();
    expect(await harness.db.select().from(events)).toHaveLength(0);
  });

  it("books anyway when the re-check itself errors", async () => {
    const cast = await seedCast();
    nylas.getCollectiveAvailability.mockRejectedValue(new Error("Nylas down"));

    // Fails open on purpose: a broken guard must not become a second thing
    // that can stop real bookings.
    const res = await post(body(cast));
    expect(res.status).toBe(200);
  });

  it("refuses when the lead is not a facilitator", async () => {
    const cast = await seedCast();
    const notLead = await seedMember({ email: "nope@example.com" });
    await seedConnection({ memberId: notLead.id, grantEmail: notLead.email, grantId: "g-n" });

    const res = await post(body(cast, { organizerMemberId: notLead.id }));
    expect(res.status).toBe(400);
    expect(nylas.createNylasEvent).not.toHaveBeenCalled();
  });

  it("refuses when the advisor is not marked as one", async () => {
    const cast = await seedCast();
    const res = await post(body(cast, { advisorMemberId: cast.founder.id, guestMemberIds: [] }));
    expect(res.status).toBe(400);
  });

  it("refuses when the lead would be the only person", async () => {
    const cast = await seedCast();
    const res = await post(body(cast, { guestMemberIds: [cast.lead.id], advisorMemberId: null }));
    expect(res.status).toBe(400);
  });

  it("refuses when the lead has no usable calendar", async () => {
    const lead = await seedMember({ email: "tobias@foundernexus.com", isFacilitator: true });
    const founder = await seedMember({ email: "f@example.com" });
    await seedConnection({ memberId: founder.id, grantEmail: founder.email, grantId: "g-f" });
    // Connected, but under a retired Nylas app.
    await seedConnection({
      memberId: lead.id,
      grantEmail: lead.email,
      grantId: "g-stale",
      refreshToken: null,
    });

    const res = await post({
      organizerMemberId: lead.id,
      guestMemberIds: [founder.id],
      title: "x",
      startsAtUnix: SLOT,
      durationMinutes: 60,
      timezone: "America/Los_Angeles",
    });
    expect(res.status).toBe(400);
  });
});
