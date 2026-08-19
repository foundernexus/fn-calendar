import { describe, it, expect } from "vitest";
import { mergeIntervals, computeCollectiveSlots } from "@/lib/calendar/slots";

/** These replace what Nylas's collective availability query used to decide for
 * us. Getting them wrong doesn't throw — it silently offers a time when someone
 * is busy, or hides one when they're free — so the edges are covered
 * deliberately. */

const at = (iso: string) => Math.floor(Date.parse(iso) / 1000);

// 2026-08-19 is a Wednesday. Los Angeles is UTC-7 in August, so 09:00 PT is
// 16:00 UTC — every expectation below is written in UTC to stay unambiguous.
const TZ = "America/Los_Angeles";
const DAY_START = at("2026-08-19T07:00:00Z"); // 00:00 PT
const DAY_END = at("2026-08-20T06:59:00Z"); // 23:59 PT

function slots(over: Partial<Parameters<typeof computeCollectiveSlots>[0]> = {}) {
  return computeCollectiveSlots({
    participants: [{ email: "a@example.com", busy: [] }],
    startTime: DAY_START,
    endTime: DAY_END,
    durationMinutes: 60,
    timezone: TZ,
    workingHoursStart: "09:00",
    workingHoursEnd: "17:00",
    excludeWeekends: true,
    ...over,
  });
}

describe("mergeIntervals", () => {
  it("coalesces overlapping blocks", () => {
    expect(mergeIntervals([{ start: 0, end: 100 }, { start: 50, end: 200 }])).toEqual([
      { start: 0, end: 200 },
    ]);
  });

  it("coalesces blocks that merely touch", () => {
    // Two back-to-back meetings are one continuous busy span.
    expect(mergeIntervals([{ start: 0, end: 100 }, { start: 100, end: 200 }])).toEqual([
      { start: 0, end: 200 },
    ]);
  });

  it("leaves a real gap alone", () => {
    expect(mergeIntervals([{ start: 200, end: 300 }, { start: 0, end: 100 }])).toEqual([
      { start: 0, end: 100 },
      { start: 200, end: 300 },
    ]);
  });
});

describe("a clear day", () => {
  it("offers every half-hour that fits inside working hours", () => {
    const result = slots();
    // 09:00 through 16:00 inclusive, stepping 30 minutes, because a 16:30 start
    // would run past 17:00.
    expect(result).toHaveLength(15);
    expect(result[0].startTime).toBe(at("2026-08-19T16:00:00Z"));
    expect(result[result.length - 1].startTime).toBe(at("2026-08-19T23:00:00Z"));
  });

  it("never starts a session that would run past the closing time", () => {
    const result = slots({ durationMinutes: 90 });
    const last = result[result.length - 1];
    expect(last.endTime).toBeLessThanOrEqual(at("2026-08-20T00:00:00Z")); // 17:00 PT
  });
});

describe("busy time", () => {
  it("keeps a slot that ends exactly when a meeting starts", () => {
    // Half-open intervals: 09:00-10:00 is free even with a 10:00 meeting, which
    // is how back-to-back scheduling is supposed to work.
    const result = slots({
      participants: [
        {
          email: "a@example.com",
          busy: [{ start: at("2026-08-19T17:00:00Z"), end: at("2026-08-19T18:00:00Z") }],
        },
      ],
    });
    expect(result.map((s) => s.startTime)).toContain(at("2026-08-19T16:00:00Z"));
  });

  it("drops every slot that overlaps a meeting, including one that only clips it", () => {
    const result = slots({
      participants: [
        {
          email: "a@example.com",
          busy: [{ start: at("2026-08-19T17:00:00Z"), end: at("2026-08-19T18:00:00Z") }],
        },
      ],
    });
    const starts = result.map((s) => s.startTime);
    expect(starts).not.toContain(at("2026-08-19T16:30:00Z")); // 09:30-10:30 clips it
    expect(starts).not.toContain(at("2026-08-19T17:00:00Z"));
    expect(starts).not.toContain(at("2026-08-19T17:30:00Z"));
    expect(starts).toContain(at("2026-08-19T18:00:00Z")); // 11:00, clear again
  });

  it("removes a slot when only ONE participant is busy", () => {
    // The whole point of a collective search: everyone, or nobody.
    const result = slots({
      participants: [
        { email: "free@example.com", busy: [] },
        {
          email: "busy@example.com",
          busy: [{ start: at("2026-08-19T16:00:00Z"), end: at("2026-08-19T17:00:00Z") }],
        },
      ],
    });
    expect(result.map((s) => s.startTime)).not.toContain(at("2026-08-19T16:00:00Z"));
  });

  it("names every participant on each returned slot", () => {
    const result = slots({
      participants: [
        { email: "a@example.com", busy: [] },
        { email: "b@example.com", busy: [] },
      ],
    });
    expect(result[0].emails).toEqual(["a@example.com", "b@example.com"]);
  });
});

describe("boundaries", () => {
  it("returns nothing when nobody is selected", () => {
    // Not "everything is free" — that would read as a working search and book
    // a session with no attendees.
    expect(slots({ participants: [] })).toEqual([]);
  });

  it("skips weekends when asked", () => {
    // 2026-08-22 is a Saturday.
    const sat = { startTime: at("2026-08-22T07:00:00Z"), endTime: at("2026-08-23T06:59:00Z") };
    expect(slots({ ...sat, excludeWeekends: true })).toHaveLength(0);
    expect(slots({ ...sat, excludeWeekends: false }).length).toBeGreaterThan(0);
  });

  it("never returns a slot outside the requested window", () => {
    // A window that opens mid-morning must not be back-filled with 09:00.
    const result = slots({
      startTime: at("2026-08-19T18:00:00Z"), // 11:00 PT
      endTime: at("2026-08-19T21:00:00Z"), // 14:00 PT
    });
    expect(result.every((s) => s.startTime >= at("2026-08-19T18:00:00Z"))).toBe(true);
    expect(result.every((s) => s.endTime <= at("2026-08-19T21:00:00Z"))).toBe(true);
  });

  it("lands every slot on the grid the UI draws", () => {
    // availability-grid.tsx steps from workingHoursStart in 30-minute
    // increments. A slot on any other boundary falls between rows and vanishes
    // from the page without any error.
    const result = slots();
    const first = result[0].startTime;
    expect(result.every((s) => (s.startTime - first) % 1800 === 0)).toBe(true);
  });

  it("produces no duplicate start times across a DST change", () => {
    // 2026-11-01 is when US clocks go back. The day-either-side walk can
    // generate the same wall-clock time on two UTC instants.
    const result = slots({
      startTime: at("2026-10-31T07:00:00Z"),
      endTime: at("2026-11-03T08:00:00Z"),
      excludeWeekends: false,
    });
    expect(new Set(result.map((s) => s.startTime)).size).toBe(result.length);
  });
});
