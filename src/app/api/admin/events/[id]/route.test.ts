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
import { events } from "@/db/schema";
import { computeIdempotencyKey } from "@/lib/idempotency";

/** Cancelling and moving both reach the calendar provider before touching our
 * own rows, and both used to leave the two out of step. */

let harness: TestDb;

/** Typed arguments so the tests can assert WHICH grant was used — the whole
 * point of the organizer_grant_id column. */
type GrantArgs = { organizerGrantId: string; nylasEventId: string };

const nylas = {
  cancelNylasEvent: vi.fn(async (_a: GrantArgs) => ({})),
  rescheduleNylasEvent: vi.fn(async (_a: GrantArgs & { startTime: number }) => ({})),
};

vi.mock("@/lib/nylas", () => ({
  cancelNylasEvent: (a: GrantArgs) => nylas.cancelNylasEvent(a),
  rescheduleNylasEvent: (a: GrantArgs & { startTime: number }) => nylas.rescheduleNylasEvent(a),
}));

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
  nylas.cancelNylasEvent.mockResolvedValue({});
  nylas.rescheduleNylasEvent.mockResolvedValue({});
  vi.resetModules();
  mockCookies(await adminCookie());
  await reinstallTestDb();
});

async function seedBooked(over: { organizerGrantId?: string | null } = {}) {
  const lead = await seedMember({ email: "tobias@foundernexus.com", isFacilitator: true });
  const founder = await seedMember({ email: "founder@example.com" });
  await seedConnection({ memberId: lead.id, grantEmail: lead.email, grantId: "g-current" });
  const key = await computeIdempotencyKey({
    guestMemberIds: [founder.id],
    startsAtUnix: SLOT,
    durationMinutes: 60,
  });
  const event = await seedEvent({
    organizerMemberId: lead.id,
    idempotencyKey: key,
    startsAt: new Date(SLOT * 1000),
    organizerGrantId: over.organizerGrantId === undefined ? "g-booked-on" : over.organizerGrantId,
    attendees: [
      { memberId: lead.id, email: lead.email },
      { memberId: founder.id, email: founder.email },
    ],
  });
  return { lead, founder, event, key };
}

async function cancel(id: number) {
  const { DELETE } = await import("./route");
  return DELETE(new Request(`http://localhost/api/admin/events/${id}`, { method: "DELETE" }), {
    params: Promise.resolve({ id: String(id) }),
  });
}

async function reschedule(id: number, startsAtUnix: number) {
  const { PATCH } = await import("./route");
  return PATCH(
    jsonRequest(
      `http://localhost/api/admin/events/${id}`,
      { startsAtUnix, durationMinutes: 60, timezone: "America/Los_Angeles" },
      { cookie: await adminCookie(), method: "PATCH" }
    ),
    { params: Promise.resolve({ id: String(id) }) }
  );
}

describe("cancelling", () => {
  it("marks it cancelled and frees the idempotency key", async () => {
    const { event, key } = await seedBooked();
    const res = await cancel(event.id);
    expect(res.status).toBe(200);

    const [row] = await harness.db.select().from(events).where(eq(events.id, event.id));
    expect(row.status).toBe("cancelled");
    // The column is UNIQUE, so a cancelled row holding its key blocked ever
    // rebooking those people at that time — the request came back 200
    // "already exists" with no event and no invites.
    expect(row.idempotencyKey).not.toBe(key);
    expect(row.idempotencyKey).toContain(key);
  });

  it("uses the grant the event was created on, not the lead's current one", async () => {
    const { event } = await seedBooked({ organizerGrantId: "g-booked-on" });
    await cancel(event.id);

    // Nylas resolves an event id within a grant. Re-deriving the lead's
    // connection would target whichever calendar they now use and 404, while
    // the meeting stayed in everyone's diary.
    expect(nylas.cancelNylasEvent.mock.calls[0]![0].organizerGrantId).toBe("g-booked-on");
  });

  it("falls back to the lead's connection for rows predating that column", async () => {
    const { event } = await seedBooked({ organizerGrantId: null });
    await cancel(event.id);
    expect(nylas.cancelNylasEvent.mock.calls[0]![0].organizerGrantId).toBe("g-current");
  });

  it("leaves the row untouched when the provider refuses", async () => {
    const { event } = await seedBooked();
    nylas.cancelNylasEvent.mockRejectedValue(new Error("nope"));

    const res = await cancel(event.id);

    expect(res.status).toBe(502);
    // Marking it cancelled here would show it gone from the grid while every
    // attendee still had it in their calendar, and people would turn up.
    const [row] = await harness.db.select().from(events).where(eq(events.id, event.id));
    expect(row.status).toBe("confirmed");
  });

  it("treats an already-cancelled session as success", async () => {
    const { event } = await seedBooked();
    await cancel(event.id);
    const second = await cancel(event.id);
    expect(second.status).toBe(200);
    expect((await second.json()).alreadyCancelled).toBe(true);
    expect(nylas.cancelNylasEvent).toHaveBeenCalledTimes(1);
  });

  it("404s on a session that does not exist", async () => {
    expect((await cancel(4242)).status).toBe(404);
  });
});

describe("rescheduling", () => {
  it("moves the event and updates the key to match the new time", async () => {
    const { event, founder, key } = await seedBooked();
    const newSlot = SLOT + 86_400;

    const res = await reschedule(event.id, newSlot);
    expect(res.status).toBe(200);

    const [row] = await harness.db.select().from(events).where(eq(events.id, event.id));
    expect(Math.floor(row.startsAt.getTime() / 1000)).toBe(newSlot);
    // The key encodes people AND time. Leaving the old one would let the very
    // same session be booked again at its new time without tripping the
    // duplicate check.
    const expected = await computeIdempotencyKey({
      guestMemberIds: [founder.id],
      startsAtUnix: newSlot,
      durationMinutes: 60,
    });
    expect(row.idempotencyKey).toBe(expected);
    expect(row.idempotencyKey).not.toBe(key);
  });

  it("moves rather than cancelling", async () => {
    const { event } = await seedBooked();
    await reschedule(event.id, SLOT + 86_400);
    // Attendees should get an update, not a cancellation followed by a fresh
    // invite that loses their RSVP.
    expect(nylas.rescheduleNylasEvent).toHaveBeenCalledTimes(1);
    expect(nylas.cancelNylasEvent).not.toHaveBeenCalled();
  });

  it("refuses when another session already holds the new slot", async () => {
    const { event, founder, lead } = await seedBooked();
    const clashKey = await computeIdempotencyKey({
      guestMemberIds: [founder.id],
      startsAtUnix: SLOT + 86_400,
      durationMinutes: 60,
    });
    await seedEvent({
      organizerMemberId: lead.id,
      idempotencyKey: clashKey,
      startsAt: new Date((SLOT + 86_400) * 1000),
    });

    const res = await reschedule(event.id, SLOT + 86_400);
    expect(res.status).toBe(409);
    expect(nylas.rescheduleNylasEvent).not.toHaveBeenCalled();
  });

  it("refuses to move a cancelled session", async () => {
    const { event } = await seedBooked();
    await cancel(event.id);
    const res = await reschedule(event.id, SLOT + 86_400);
    expect(res.status).toBe(409);
  });

  it("leaves the row at the old time when the provider refuses", async () => {
    const { event } = await seedBooked();
    nylas.rescheduleNylasEvent.mockRejectedValue(new Error("nope"));

    const res = await reschedule(event.id, SLOT + 86_400);

    expect(res.status).toBe(502);
    const [row] = await harness.db.select().from(events).where(eq(events.id, event.id));
    expect(Math.floor(row.startsAt.getTime() / 1000)).toBe(SLOT);
  });
});

describe("auth", () => {
  it("rejects cancelling without an admin session", async () => {
    const { event } = await seedBooked();
    vi.resetModules();
    mockCookies();
    await reinstallTestDb();
    const { DELETE } = await import("./route");
    const res = await DELETE(new Request("http://localhost/x", { method: "DELETE" }), {
      params: Promise.resolve({ id: String(event.id) }),
    });
    expect(res.status).toBe(401);
    expect(nylas.cancelNylasEvent).not.toHaveBeenCalled();
  });
});
