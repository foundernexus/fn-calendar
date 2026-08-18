import { describe, it, expect } from "vitest";
import { computeIdempotencyKey } from "./idempotency";

describe("computeIdempotencyKey", () => {
  it("is deterministic for the same inputs", async () => {
    const a = await computeIdempotencyKey({ guestMemberIds: [3, 5], startsAtUnix: 1000, durationMinutes: 30 });
    const b = await computeIdempotencyKey({ guestMemberIds: [3, 5], startsAtUnix: 1000, durationMinutes: 30 });
    expect(a).toBe(b);
  });

  it("is independent of guest ID order", async () => {
    const a = await computeIdempotencyKey({ guestMemberIds: [3, 5], startsAtUnix: 1000, durationMinutes: 30 });
    const b = await computeIdempotencyKey({ guestMemberIds: [5, 3], startsAtUnix: 1000, durationMinutes: 30 });
    expect(a).toBe(b);
  });

  it("differs when the guest list differs", async () => {
    const a = await computeIdempotencyKey({ guestMemberIds: [3, 5], startsAtUnix: 1000, durationMinutes: 30 });
    const b = await computeIdempotencyKey({ guestMemberIds: [3, 6], startsAtUnix: 1000, durationMinutes: 30 });
    expect(a).not.toBe(b);
  });

  it("differs when the start time differs", async () => {
    const a = await computeIdempotencyKey({ guestMemberIds: [3, 5], startsAtUnix: 1000, durationMinutes: 30 });
    const b = await computeIdempotencyKey({ guestMemberIds: [3, 5], startsAtUnix: 2000, durationMinutes: 30 });
    expect(a).not.toBe(b);
  });

  it("differs when the duration differs", async () => {
    const a = await computeIdempotencyKey({ guestMemberIds: [3, 5], startsAtUnix: 1000, durationMinutes: 30 });
    const b = await computeIdempotencyKey({ guestMemberIds: [3, 5], startsAtUnix: 1000, durationMinutes: 60 });
    expect(a).not.toBe(b);
  });

  describe("with an advisor", () => {
    const base = { guestMemberIds: [3, 5], startsAtUnix: 1000, durationMinutes: 30 };

    it("differs when the advisor differs", async () => {
      // The bug this guards: same founders, same slot, different advisor is a
      // genuinely different session. Leaving the advisor out of the hash made
      // the second booking collide with the first and get rejected.
      const a = await computeIdempotencyKey({ ...base, advisorMemberId: 7 });
      const b = await computeIdempotencyKey({ ...base, advisorMemberId: 8 });
      expect(a).not.toBe(b);
    });

    it("differs from the same session booked without an advisor", async () => {
      const withAdvisor = await computeIdempotencyKey({ ...base, advisorMemberId: 7 });
      const without = await computeIdempotencyKey(base);
      expect(withAdvisor).not.toBe(without);
    });

    it("is unchanged from the pre-advisor format when there is no advisor", async () => {
      // Guarantees advisor-less bookings behave exactly as before, so existing
      // rows keep matching and nothing silently double-books.
      const omitted = await computeIdempotencyKey(base);
      const explicitlyNull = await computeIdempotencyKey({ ...base, advisorMemberId: null });
      const explicitlyUndefined = await computeIdempotencyKey({
        ...base,
        advisorMemberId: undefined,
      });
      expect(explicitlyNull).toBe(omitted);
      expect(explicitlyUndefined).toBe(omitted);
    });

    it("treats the advisor as distinct from a guest with the same id", async () => {
      // [3,5] + advisor 7 must not collide with [3,5,7] and no advisor.
      const asAdvisor = await computeIdempotencyKey({ ...base, advisorMemberId: 7 });
      const asGuest = await computeIdempotencyKey({ ...base, guestMemberIds: [3, 5, 7] });
      expect(asAdvisor).not.toBe(asGuest);
    });
  });
});
