import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import { createTestDb, reinstallTestDb, type TestDb } from "@/test/db";
import { seedMember, seedConnection, seedEvent } from "@/test/helpers";
import { eventAttendees } from "@/db/schema";
import type { ProviderAttendance } from "@/lib/calendar/attendance";

/** Reading RSVPs back off the organiser's calendar.
 *
 * Almost every test here is about a failure, and that is the right proportion.
 * The happy path is a map lookup; the whole risk of this job is that a bad
 * minute at Google turns into a row that says somebody declined when they
 * didn't, or that a real acceptance gets flattened back to "no reply". */

let harness: TestDb;

/** What the provider answers with. Set per test — either a list, or a thrown
 * error to exercise one of the skip paths. */
let attendance: ProviderAttendance[] | Error = [];

vi.mock("@/lib/calendar", () => ({
  asCalendarProvider: (value: string | null | undefined) =>
    value === "microsoft" ? "microsoft" : "google",
  fetchEventAttendance: () => {
    if (attendance instanceof Error) return Promise.reject(attendance);
    return Promise.resolve(attendance);
  },
}));

/** The real module, minus the network: ConnectionUnusableError has to stay the
 * genuine class or the `instanceof` branch in refreshAttendance is untested. */
vi.mock("@/lib/calendar/tokens", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/calendar/tokens")>();
  return { ...actual, getAccessToken: () => Promise.resolve("test-access-token") };
});

beforeAll(async () => {
  harness = await createTestDb();
});
afterAll(async () => {
  await harness.close();
});
beforeEach(async () => {
  await harness.reset();
  vi.clearAllMocks();
  attendance = [];
  vi.resetModules();
  await reinstallTestDb();
});

/** A confirmed session tomorrow with the lead and one guest on it, carrying the
 * provider id and connection id that make it readable back. */
async function seedSession(over: { providerEventId?: string | null } = {}) {
  const lead = await seedMember({ email: "karink@foundernexus.com", isFacilitator: true });
  const guest = await seedMember({ email: "anil@ternion.security", fullName: "Anil Karmel" });
  const connection = await seedConnection({
    memberId: lead.id,
    grantEmail: lead.email,
    isPrimary: true,
  });

  const event = await seedEvent({
    organizerMemberId: lead.id,
    idempotencyKey: `session-${Date.now()}`,
    startsAt: new Date(Date.now() + 86_400_000),
    durationMinutes: 15,
    providerEventId: over.providerEventId === undefined ? "google-event-1" : over.providerEventId,
    organizerConnectionId: connection.id,
    attendees: [
      { memberId: lead.id, email: lead.email },
      { memberId: guest.id, email: guest.email },
    ],
  });

  return { event, lead, guest, connection };
}

async function run() {
  const { refreshAttendance } = await import("@/lib/attendance");
  return refreshAttendance();
}

async function statuses() {
  const rows = await harness.db.select().from(eventAttendees);
  return Object.fromEntries(rows.map((r) => [r.attendeeEmail, r.responseStatus]));
}

describe("reading the answers", () => {
  it("records what each person said", async () => {
    const { lead, guest } = await seedSession();
    attendance = [
      { email: lead.email, response: "accepted" },
      { email: guest.email, response: "declined" },
    ];

    const summary = await run();

    expect(summary).toEqual({ checked: 1, skipped: 0, updated: 2 });
    expect(await statuses()).toEqual({
      [lead.email]: "yes",
      [guest.email]: "no",
    });
  });

  it("matches addresses that differ only in casing", async () => {
    // We store whatever was typed or connected; the provider echoes its own
    // casing back. A missed match here looks exactly like "hasn't replied".
    const { guest } = await seedSession();
    attendance = [{ email: guest.email.toUpperCase(), response: "accepted" }];

    await run();

    expect((await statuses())[guest.email]).toBe("yes");
  });

  it("reads a repeating session too", async () => {
    // A series is one row carrying a rule, and one event at the provider. The
    // answer read here is the series-wide one — what somebody said when they
    // accepted the invitation — not a per-date answer, because there is only
    // one invitation to accept. Covered because a monthly 1:1 is exactly the
    // kind of session this tool books.
    const { event, lead, guest } = await seedSession();
    const { eq } = await import("drizzle-orm");
    const { events } = await import("@/db/schema");
    await harness.db
      .update(events)
      .set({ recurrenceRule: "RRULE:FREQ=WEEKLY;INTERVAL=4;COUNT=6" })
      .where(eq(events.id, event.id));
    attendance = [
      { email: lead.email, response: "accepted" },
      { email: guest.email, response: "accepted" },
    ];

    expect(await run()).toEqual({ checked: 1, skipped: 0, updated: 2 });
  });

  it("changes nothing on a second run", async () => {
    const { lead, guest } = await seedSession();
    attendance = [
      { email: lead.email, response: "accepted" },
      { email: guest.email, response: "tentative" },
    ];

    await run();
    const second = await run();

    expect(second).toEqual({ checked: 1, skipped: 0, updated: 0 });
  });
});

describe("what it refuses to overwrite", () => {
  /** Sets a known answer, so a test can prove the job left it standing. */
  async function alreadyAccepted(email: string) {
    const { eq } = await import("drizzle-orm");
    await harness.db
      .update(eventAttendees)
      .set({ responseStatus: "yes" })
      .where(eq(eventAttendees.attendeeEmail, email));
  }

  it("leaves the stored answer alone when the provider errors", async () => {
    const { guest } = await seedSession();
    await alreadyAccepted(guest.email);
    attendance = new Error("Google event attendance failed (500): upstream");

    const summary = await run();

    expect(summary).toEqual({ checked: 0, skipped: 1, updated: 0 });
    expect((await statuses())[guest.email]).toBe("yes");
  });

  it("skips quietly when the event has been deleted at the provider", async () => {
    // The organiser removed it in Google, which they're entitled to do. Routine,
    // not a fault — and emphatically not a reason to rewrite anybody's answer.
    const { guest } = await seedSession();
    await alreadyAccepted(guest.email);
    const gone = Object.assign(new Error("Google event attendance failed (404)"), { status: 404 });
    attendance = gone;

    const summary = await run();

    expect(summary).toEqual({ checked: 0, skipped: 1, updated: 0 });
    expect((await statuses())[guest.email]).toBe("yes");
  });

  it("skips a connection that has to be reconnected", async () => {
    const { guest } = await seedSession();
    await alreadyAccepted(guest.email);
    const { ConnectionUnusableError } = await import("@/lib/calendar/tokens");
    attendance = new ConnectionUnusableError(1, "reconnect required");

    const summary = await run();

    expect(summary).toEqual({ checked: 0, skipped: 1, updated: 0 });
    expect((await statuses())[guest.email]).toBe("yes");
  });

  it("leaves anyone the provider didn't mention", async () => {
    // Removed from the event in Google, or invited at another address. Either
    // way we've learned nothing about them.
    const { lead, guest } = await seedSession();
    await alreadyAccepted(guest.email);
    attendance = [{ email: lead.email, response: "accepted" }];

    const summary = await run();

    expect(summary.updated).toBe(1);
    expect((await statuses())[guest.email]).toBe("yes");
  });

  it("leaves a row whose status it doesn't recognise", async () => {
    // The property everything else rests on: an unfamiliar value is "no new
    // information", never a reset to noreply.
    const { guest } = await seedSession();
    await alreadyAccepted(guest.email);
    attendance = [{ email: guest.email, response: "somethingNew" }];

    const summary = await run();

    expect(summary).toEqual({ checked: 1, skipped: 0, updated: 0 });
    expect((await statuses())[guest.email]).toBe("yes");
  });
});

describe("what it doesn't look at", () => {
  it("ignores events with no provider id", async () => {
    // A Nylas-era row. There is no id to ask about and never will be.
    await seedSession({ providerEventId: null });
    attendance = [{ email: "karink@foundernexus.com", response: "accepted" }];

    expect(await run()).toEqual({ checked: 0, skipped: 0, updated: 0 });
  });

  it("ignores cancelled sessions", async () => {
    const lead = await seedMember({ email: "karink@foundernexus.com", isFacilitator: true });
    const connection = await seedConnection({ memberId: lead.id, grantEmail: lead.email });
    await seedEvent({
      organizerMemberId: lead.id,
      idempotencyKey: "cancelled-1",
      startsAt: new Date(Date.now() + 86_400_000),
      status: "cancelled",
      providerEventId: "google-event-cancelled",
      organizerConnectionId: connection.id,
      attendees: [{ memberId: lead.id, email: lead.email }],
    });

    expect(await run()).toEqual({ checked: 0, skipped: 0, updated: 0 });
  });

  it("ignores sessions that finished more than a day ago", async () => {
    const lead = await seedMember({ email: "karink@foundernexus.com", isFacilitator: true });
    const connection = await seedConnection({ memberId: lead.id, grantEmail: lead.email });
    await seedEvent({
      organizerMemberId: lead.id,
      idempotencyKey: "old-1",
      startsAt: new Date(Date.now() - 5 * 86_400_000),
      providerEventId: "google-event-old",
      organizerConnectionId: connection.id,
      attendees: [{ memberId: lead.id, email: lead.email }],
    });

    expect(await run()).toEqual({ checked: 0, skipped: 0, updated: 0 });
  });

  it("still looks at one that finished this morning", async () => {
    // Somebody accepts on the day. A job that only looked forward would never
    // record it.
    const lead = await seedMember({ email: "karink@foundernexus.com", isFacilitator: true });
    const connection = await seedConnection({ memberId: lead.id, grantEmail: lead.email });
    await seedEvent({
      organizerMemberId: lead.id,
      idempotencyKey: "this-morning",
      startsAt: new Date(Date.now() - 3 * 3_600_000),
      durationMinutes: 30,
      providerEventId: "google-event-today",
      organizerConnectionId: connection.id,
      attendees: [{ memberId: lead.id, email: lead.email }],
    });
    attendance = [{ email: lead.email, response: "accepted" }];

    expect(await run()).toEqual({ checked: 1, skipped: 0, updated: 1 });
  });
});
