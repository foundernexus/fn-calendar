import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import { createTestDb, reinstallTestDb, type TestDb } from "@/test/db";
import { seedMember, seedConnection, seedEvent } from "@/test/helpers";
import { sessionConflicts } from "@/db/schema";

/** The daily look-ahead over repeating sessions.
 *
 * Nobody watches this run, which is exactly why it needs tests: a check that
 * quietly stopped working would leave the list reassuringly empty while clashes
 * piled up behind it. */

let harness: TestDb;

/** Anyone whose calendar shows something OTHER than this session over the
 * date. Set per test. */
let clashingNames: string[] = [];
/** Anyone whose stated weekly hours rule the slot out. Set per test. */
let outsideHours: string[] = [];

vi.mock("@/lib/calendar/booking-guards", () => ({
  occurrenceClashes: () => Promise.resolve(clashingNames),
  participantsOutsideStatedHours: () => Promise.resolve(outsideHours),
}));

beforeAll(async () => {
  harness = await createTestDb();
});
afterAll(async () => {
  await harness.close();
});
beforeEach(async () => {
  await harness.reset();
  vi.clearAllMocks();
  clashingNames = [];
  outsideHours = [];
  vi.resetModules();
  await reinstallTestDb();
});

/** A four-weekly series whose first date is a week from `now`, so the check's
 * window covers the first few repeats. */
async function seedSeries(over: { rule?: string | null } = {}) {
  const lead = await seedMember({ email: "karin@foundernexus.com", isFacilitator: true });
  const founder = await seedMember({ email: "yuan@example.com", fullName: "Yuan Sun" });
  await seedConnection({ memberId: lead.id, grantEmail: lead.email, grantId: "g-lead" });
  await seedConnection({ memberId: founder.id, grantEmail: founder.email, grantId: "g-f" });

  const startsAt = new Date(Date.now() + 7 * 86_400_000);
  const event = await seedEvent({
    organizerMemberId: lead.id,
    idempotencyKey: `series-${Date.now()}`,
    startsAt,
    durationMinutes: 30,
    attendees: [
      { memberId: lead.id, email: lead.email },
      { memberId: founder.id, email: founder.email },
    ],
  });

  const rule = over.rule === undefined ? "RRULE:FREQ=WEEKLY;INTERVAL=4" : over.rule;
  if (rule !== null) {
    const { db } = await import("@/db");
    const { events } = await import("@/db/schema");
    const { eq } = await import("drizzle-orm");
    await db.update(events).set({ recurrenceRule: rule }).where(eq(events.id, event.id));
  }
  return { event, lead, founder };
}

async function run() {
  const { detectSeriesConflicts } = await import("@/lib/conflicts");
  return detectSeriesConflicts();
}

async function openConflicts() {
  return harness.db.select().from(sessionConflicts);
}

describe("the daily look-ahead", () => {
  it("raises nothing while the later dates are still clear", async () => {
    await seedSeries();
    const summary = await run();

    expect(summary.series).toBe(1);
    expect(summary.occurrences).toBeGreaterThan(1);
    expect(await openConflicts()).toHaveLength(0);
  });

  it("records the date somebody has since booked over", async () => {
    // The case this exists for: a series agreed once, and a flight put in front
    // of the fourth date months later. Without something looking, nobody finds
    // out until the day.
    await seedSeries();
    clashingNames = ["Yuan Sun"];

    const summary = await run();
    const conflicts = await openConflicts();

    expect(summary.raised).toBeGreaterThan(0);
    expect(conflicts.length).toBe(summary.raised);
    expect(conflicts[0].resolvedAt).toBeNull();
  });

  it("names whoever's stated hours rule the date out", async () => {
    // Stored resolved to names, not looked up on read: the answer is a fact
    // about the moment it was detected, and the calendar will have moved on.
    await seedSeries();
    outsideHours = ["Yuan Sun"];

    await run();
    expect((await openConflicts())[0].conflictingNames).toBe("Yuan Sun");
  });

  it("raises a date once, not once per day until somebody deals with it", async () => {
    await seedSeries();
    clashingNames = ["Yuan Sun"];

    await run();
    const first = (await openConflicts()).length;
    await run();

    expect((await openConflicts()).length).toBe(first);
  });

  it("resolves a clash that sorted itself out", async () => {
    // Resolved rather than deleted, so the list can say it went away instead of
    // the row quietly vanishing overnight.
    await seedSeries();
    clashingNames = ["Yuan Sun"];
    await run();

    clashingNames = [];
    const summary = await run();

    expect(summary.resolved).toBeGreaterThan(0);
    expect((await openConflicts()).every((c) => c.resolvedAt !== null)).toBe(true);
  });

  it("leaves a one-off session alone", async () => {
    // Only a series has dates nobody has looked at. A single booking was
    // checked when it was made and belongs to whoever made it.
    await seedSeries({ rule: null });
    clashingNames = ["Yuan Sun"];

    const summary = await run();
    expect(summary.series).toBe(0);
    expect(await openConflicts()).toHaveLength(0);
  });

  it("leaves a rule it cannot read alone", async () => {
    // Somebody rebuilt the series in Google to repeat on the 15th of every
    // month. Half-understanding that would raise warnings about dates that are
    // not in the series at all.
    //
    // Was "the second Tuesday" until this app learned to write monthly rules
    // itself. The point of the test is a rule we do NOT write, so it moved to
    // one that is still outside what parseRecurrence accepts.
    await seedSeries({ rule: "RRULE:FREQ=MONTHLY;BYMONTHDAY=15" });
    clashingNames = ["Yuan Sun"];

    const summary = await run();
    expect(summary.occurrences).toBe(0);
    expect(await openConflicts()).toHaveLength(0);
  });

  it("says nothing about the date that was actually booked", async () => {
    // The first date of a series was checked at booking time. Reporting it
    // would put a conflict on the one row that is working.
    const { event } = await seedSeries();
    clashingNames = ["Yuan Sun"];

    await run();
    const firstDate = event.startsAt.getTime();
    expect(
      (await openConflicts()).some((c) => c.occurrenceStartsAt.getTime() === firstDate)
    ).toBe(false);
  });
});
