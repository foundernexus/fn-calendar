import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import { createTestDb, reinstallTestDb, type TestDb } from "@/test/db";
import { seedMember, seedConnection, seedEvent } from "@/test/helpers";

/** What counts as "a 1:1 with Karin".
 *
 * This decides what lands in HubSpot's `FN Next Monthly 1:1`, and the column is
 * only worth having if it means one thing. HubSpot's own Next Activity Date was
 * discarded for exactly this reason — it counted anybody's meeting with
 * anybody, so a member with somebody else's call booked read as handled. */

let harness: TestDb;

beforeAll(async () => {
  harness = await createTestDb();
});
afterAll(async () => {
  await harness.close();
});
beforeEach(async () => {
  await harness.reset();
  vi.resetModules();
  await reinstallTestDb();
});

const FUTURE = new Date(Date.now() + 7 * 86_400_000);
const PAST = new Date(Date.now() - 7 * 86_400_000);

async function cast() {
  const karin = await seedMember({ email: "karin@foundernexus.com", isFacilitator: true });
  const member = await seedMember({ email: "yuan@example.com", fullName: "Yuan Sun" });
  const other = await seedMember({ email: "chris@example.com", fullName: "Chris Jackson" });
  const advisor = await seedMember({ email: "court@foundernexus.com", isAdvisor: true });
  return { karin, member, other, advisor };
}

async function states() {
  const { oneToOneStates } = await import("@/lib/one-to-one");
  return oneToOneStates();
}

describe("what counts as a 1:1", () => {
  it("counts a facilitator plus one member", async () => {
    const c = await cast();
    await seedEvent({
      organizerMemberId: c.karin.id,
      idempotencyKey: "k1",
      startsAt: FUTURE,
      durationMinutes: 15,
      attendees: [
        { memberId: c.karin.id, email: c.karin.email },
        { memberId: c.member.id, email: c.member.email },
      ],
    });

    const found = await states();
    expect(found).toHaveLength(1);
    expect(found[0].memberId).toBe(c.member.id);
    expect(found[0].next).not.toBeNull();
  });

  it("does not count a session with two members", async () => {
    // Three people is a small session. Writing it into a field called "Monthly
    // 1:1" would turn the column into "some meeting exists", which is the
    // vagueness this whole field was chosen to avoid.
    const c = await cast();
    await seedEvent({
      organizerMemberId: c.karin.id,
      idempotencyKey: "k2",
      startsAt: FUTURE,
      attendees: [
        { memberId: c.karin.id, email: c.karin.email },
        { memberId: c.member.id, email: c.member.email },
        { memberId: c.other.id, email: c.other.email },
      ],
    });
    expect(await states()).toEqual([]);
  });

  it("does not count a session with an advisor", async () => {
    // Two people plus an advisor is an advisor session, not a check-in.
    const c = await cast();
    await seedEvent({
      organizerMemberId: c.karin.id,
      idempotencyKey: "k3",
      startsAt: FUTURE,
      attendees: [
        { memberId: c.karin.id, email: c.karin.email },
        { memberId: c.member.id, email: c.member.email },
        { memberId: c.advisor.id, email: c.advisor.email, role: "advisor" },
      ],
    });
    expect(await states()).toEqual([]);
  });

  it("does not count a session nobody on staff is leading", async () => {
    const c = await cast();
    await seedEvent({
      organizerMemberId: c.member.id,
      idempotencyKey: "k4",
      startsAt: FUTURE,
      attendees: [
        { memberId: c.member.id, email: c.member.email },
        { memberId: c.other.id, email: c.other.email },
      ],
    });
    expect(await states()).toEqual([]);
  });
});

describe("the dates it reports", () => {
  it("separates the next from the last", async () => {
    const c = await cast();
    for (const [i, when] of [PAST, FUTURE].entries()) {
      await seedEvent({
        organizerMemberId: c.karin.id,
        idempotencyKey: `d${i}`,
        startsAt: when,
        attendees: [
          { memberId: c.karin.id, email: c.karin.email },
          { memberId: c.member.id, email: c.member.email },
        ],
      });
    }

    const [state] = await states();
    expect(state.last).not.toBeNull();
    expect(state.next).not.toBeNull();
    expect(state.last!.localDate < state.next!.localDate).toBe(true);
  });

  it("gives a finite series a booked-through date", async () => {
    const c = await cast();
    const event = await seedEvent({
      organizerMemberId: c.karin.id,
      idempotencyKey: "s1",
      startsAt: FUTURE,
      attendees: [
        { memberId: c.karin.id, email: c.karin.email },
        { memberId: c.member.id, email: c.member.email },
      ],
    });
    const { db } = await import("@/db");
    const { events } = await import("@/db/schema");
    const { eq } = await import("drizzle-orm");
    await db
      .update(events)
      .set({ recurrenceRule: "RRULE:FREQ=WEEKLY;INTERVAL=4;COUNT=3" })
      .where(eq(events.id, event.id));

    const [state] = await states();
    // Both forms, because which one HubSpot wants depends on how the property
    // is typed over there — and somebody switching it from Date to
    // Date-and-time silently changed the right answer once already.
    expect(state.bookedThrough!.iso).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(state.bookedThrough!.localDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(state.bookedThrough!.localDate > state.next!.localDate).toBe(true);
  });

  it("leaves booked-through empty for a series with no end", async () => {
    // There is no date to give, and reporting the horizon we happen to walk to
    // would be a number nobody chose.
    const c = await cast();
    const event = await seedEvent({
      organizerMemberId: c.karin.id,
      idempotencyKey: "s2",
      startsAt: FUTURE,
      attendees: [
        { memberId: c.karin.id, email: c.karin.email },
        { memberId: c.member.id, email: c.member.email },
      ],
    });
    const { db } = await import("@/db");
    const { events } = await import("@/db/schema");
    const { eq } = await import("drizzle-orm");
    await db
      .update(events)
      .set({ recurrenceRule: "RRULE:FREQ=WEEKLY;INTERVAL=4" })
      .where(eq(events.id, event.id));

    const [state] = await states();
    expect(state.next).not.toBeNull();
    expect(state.bookedThrough).toBeNull();
  });

  it("carries the address their calendar is connected under", async () => {
    // Written to HubSpot so the gap between the registered address and the
    // connected one stops being an invisible reason things don't match.
    const c = await cast();
    await seedConnection({
      memberId: c.member.id,
      grantEmail: "yuan.personal@gmail.com",
      grantId: "g-yuan",
    });
    await seedEvent({
      organizerMemberId: c.karin.id,
      idempotencyKey: "e1",
      startsAt: FUTURE,
      attendees: [
        { memberId: c.karin.id, email: c.karin.email },
        { memberId: c.member.id, email: c.member.email },
      ],
    });

    const [state] = await states();
    expect(state.calendarEmail).toBe("yuan.personal@gmail.com");
  });
});
