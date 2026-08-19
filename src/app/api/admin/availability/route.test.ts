import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import { createTestDb, reinstallTestDb, type TestDb } from "@/test/db";
import {
  adminCookie,
  jsonRequest,
  mockCookies,
  seedMember,
  seedConnection,
  seedEvent,
} from "@/test/helpers";

/** The search. Nylas answers "is this free in their calendar"; everything
 * else — stated hours, which calendars count, what's already booked — is this
 * route's job, and is what these tests cover. */

let harness: TestDb;

type AvailArgs = { participantEmails: string[] };

const getCollectiveAvailability = vi.fn(
  async (_a: AvailArgs) => [] as { emails: string[]; startTime: number; endTime: number }[]
);

vi.mock("@/lib/nylas", () => ({
  getCollectiveAvailability: (a: AvailArgs) => getCollectiveAvailability(a),
}));

/** Wednesday 2026-09-02, 09:00 and 10:00 Pacific. */
const NINE = Math.floor(new Date("2026-09-02T16:00:00Z").getTime() / 1000);
const TEN = NINE + 3600;

beforeAll(async () => {
  harness = await createTestDb();
});
afterAll(async () => {
  await harness.close();
});
beforeEach(async () => {
  await harness.reset();
  vi.clearAllMocks();
  getCollectiveAvailability.mockResolvedValue([
    { emails: [], startTime: NINE, endTime: NINE + 3600 },
    { emails: [], startTime: TEN, endTime: TEN + 3600 },
  ]);
  vi.resetModules();
  mockCookies(await adminCookie());
  await reinstallTestDb();
});

async function search(over: Record<string, unknown> = {}) {
  const { POST } = await import("./route");
  const res = await POST(
    jsonRequest(
      "http://localhost/api/admin/availability",
      {
        startDate: "2026-09-02",
        endDate: "2026-09-02",
        durationMinutes: 60,
        workingHoursStart: "09:00",
        workingHoursEnd: "17:00",
        timezone: "America/Los_Angeles",
        excludeWeekends: true,
        ...over,
      },
      { cookie: await adminCookie() }
    )
  );
  return { res, body: await res.json() };
}

async function seedCast() {
  // No timezone on purpose: a member who has never saved /me is treated as
  // unconstrained. Giving the lead a timezone but no blocks would mean
  // "available never" and quietly empty every result below — see the
  // stated-availability tests for that rule.
  const lead = await seedMember({ email: "lead@foundernexus.com", isFacilitator: true });
  const founder = await seedMember({ email: "founder@example.com" });
  await seedConnection({ memberId: lead.id, grantEmail: lead.email, grantId: "g-lead" });
  await seedConnection({ memberId: founder.id, grantEmail: founder.email, grantId: "g-founder" });
  return { lead, founder };
}

describe("who gets checked", () => {
  it("sends every calendar of every participant", async () => {
    const { lead, founder } = await seedCast();
    // A second calendar for the founder — the whole point of multi-calendar:
    // they're only free if BOTH are.
    await seedConnection({
      memberId: founder.id,
      grantEmail: "founder.private@gmail.com",
      grantId: "g-private",
    });

    await search({ organizerMemberId: lead.id, guestMemberIds: [founder.id] });

    const sent = getCollectiveAvailability.mock.calls[0]![0].participantEmails;
    expect(sent).toContain("founder@example.com");
    expect(sent).toContain("founder.private@gmail.com");
    expect(sent).toContain("lead@foundernexus.com");
  });

  it("counts people, not calendars", async () => {
    const { lead, founder } = await seedCast();
    await seedConnection({
      memberId: founder.id,
      grantEmail: "second@gmail.com",
      grantId: "g-2",
    });

    const { body } = await search({ organizerMemberId: lead.id, guestMemberIds: [founder.id] });

    // "Checked 3 of 2 people" would be nonsense.
    expect(body.totalSelected).toBe(2);
    expect(body.checkedCount).toBe(2);
  });

  it("names anyone unconnected instead of silently dropping them", async () => {
    const { lead, founder } = await seedCast();
    const notConnected = await seedMember({ email: "waiting@example.com" });

    const { body } = await search({
      organizerMemberId: lead.id,
      guestMemberIds: [founder.id, notConnected.id],
    });

    expect(body.notConnectedNames).toContain("waiting@example.com");
    expect(body.checkedCount).toBe(2);
    expect(body.totalSelected).toBe(3);
  });

  it("refuses when the lead has no usable calendar", async () => {
    const lead = await seedMember({ email: "lead@foundernexus.com", isFacilitator: true });
    const founder = await seedMember({ email: "f@example.com" });
    await seedConnection({ memberId: founder.id, grantEmail: founder.email, grantId: "g-f" });
    await seedConnection({
      memberId: lead.id,
      grantEmail: lead.email,
      grantId: "g-stale",
      clientId: "retired-app",
    });

    const { body } = await search({ organizerMemberId: lead.id, guestMemberIds: [founder.id] });
    expect(body.error).toMatch(/isn't connected/);
    expect(getCollectiveAvailability).not.toHaveBeenCalled();
  });
});

describe("stated availability", () => {
  it("drops slots outside a member's own hours", async () => {
    const { lead } = await seedCast();
    const founder = await seedMember({
      email: "narrow@example.com",
      timezone: "America/Los_Angeles",
    });
    await seedConnection({ memberId: founder.id, grantEmail: founder.email, grantId: "g-n" });
    // Only 10:00–12:00 Pacific on Wednesday.
    const { db } = harness;
    const { memberAvailability } = await import("@/db/schema");
    await db.insert(memberAvailability).values({
      memberId: founder.id,
      dayOfWeek: 3,
      startTime: "10:00",
      endTime: "12:00",
    });

    const { body } = await search({ organizerMemberId: lead.id, guestMemberIds: [founder.id] });

    // Nylas offered 09:00 and 10:00; their stated hours rule out the first.
    expect(body.slots.map((s: { startUnix: number }) => s.startUnix)).toEqual([TEN]);
  });

  it("treats a member who never saved as unconstrained", async () => {
    const { lead, founder } = await seedCast();
    // founder.timezone is null — never opened /me. Blocking them by default
    // would have made every existing member unbookable the day this shipped.
    const { body } = await search({ organizerMemberId: lead.id, guestMemberIds: [founder.id] });
    expect(body.slots).toHaveLength(2);
  });

  it("says when preferences, not calendars, emptied the grid", async () => {
    const { lead } = await seedCast();
    const founder = await seedMember({
      email: "narrow@example.com",
      timezone: "America/Los_Angeles",
    });
    await seedConnection({ memberId: founder.id, grantEmail: founder.email, grantId: "g-n" });
    const { memberAvailability } = await import("@/db/schema");
    await harness.db.insert(memberAvailability).values({
      memberId: founder.id,
      dayOfWeek: 3,
      startTime: "14:00",
      endTime: "15:00",
    });

    const { body } = await search({ organizerMemberId: lead.id, guestMemberIds: [founder.id] });

    // Distinct from Nylas finding nothing: the calendars DO overlap, so the
    // UI must not say "no overlapping free time".
    expect(body.slots).toHaveLength(0);
    expect(body.filteredByPreferences).toBe(true);
  });
});

describe("already-booked sessions", () => {
  it("returns them with their attendees so a cell can be opened", async () => {
    const { lead, founder } = await seedCast();
    await seedEvent({
      organizerMemberId: lead.id,
      idempotencyKey: "k-booked",
      startsAt: new Date(NINE * 1000),
      title: "Existing session",
      attendees: [
        { memberId: lead.id, email: lead.email },
        { memberId: founder.id, email: founder.email },
      ],
    });

    const { body } = await search({ organizerMemberId: lead.id, guestMemberIds: [founder.id] });

    // Without these the grid shows an unexplained grey cell that can't be
    // cancelled or moved — the only way into a session is its cell.
    expect(body.bookedSlots).toHaveLength(1);
    expect(body.bookedSlots[0].title).toBe("Existing session");
    expect(body.bookedSlots[0].attendees).toHaveLength(2);
    expect(body.bookedSlots[0].organizerMemberId).toBe(lead.id);
  });

  it("ignores cancelled ones", async () => {
    const { lead, founder } = await seedCast();
    await seedEvent({
      organizerMemberId: lead.id,
      idempotencyKey: "k-cancelled",
      startsAt: new Date(NINE * 1000),
      status: "cancelled",
      attendees: [{ memberId: founder.id, email: founder.email }],
    });

    const { body } = await search({ organizerMemberId: lead.id, guestMemberIds: [founder.id] });
    expect(body.bookedSlots).toHaveLength(0);
  });
});

describe("guards", () => {
  it("rejects a search with no admin session", async () => {
    mockCookies();
    const { POST } = await import("./route");
    const res = await POST(jsonRequest("http://localhost/api/admin/availability", {}));
    expect(res.status).toBe(401);
  });

  it("rejects an advisor who is not marked as one", async () => {
    const { lead, founder } = await seedCast();
    const { body } = await search({
      organizerMemberId: lead.id,
      guestMemberIds: [founder.id],
      advisorMemberId: founder.id,
    });
    expect(body.error).toMatch(/isn't marked as an advisor/);
  });

  it("rejects a range longer than 60 days", async () => {
    const { lead, founder } = await seedCast();
    const { res } = await search({
      organizerMemberId: lead.id,
      guestMemberIds: [founder.id],
      endDate: "2026-12-31",
    });
    expect(res.status).toBe(400);
  });
});
