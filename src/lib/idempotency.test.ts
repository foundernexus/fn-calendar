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
});
