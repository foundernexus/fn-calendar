import { describe, it, expect } from "vitest";
import {
  occurrenceTimes,
  parseRecurrence,
  occurrencesBetween,
  recurrenceRuleString,
  monthlyPositionOf,
} from "@/lib/calendar/recurrence";
import { zonedDateTimeParts } from "@/lib/time";

/** When a repeating session actually falls. Pure arithmetic, and the one place
 * a quiet hour's drift would send everybody to the wrong meeting. */

const ZONE = "America/Los_Angeles";
const at = (iso: string) => Math.floor(Date.parse(iso) / 1000);

function localTimes(startUnix: number, intervalWeeks: number, count: number) {
  return occurrenceTimes({
    startUnix,
    durationMinutes: 30,
    recurrence: { intervalWeeks, count: null },
    count,
    timezone: ZONE,
  }).map((o) => zonedDateTimeParts(o.startUnix, ZONE));
}

describe("when a repeating session falls", () => {
  it("keeps the same wall-clock time across the end of daylight saving", () => {
    // Pacific time goes back an hour on 2026-11-01. A session at 10:00 on
    // 19 October, repeated every four weeks, must still be at 10:00 on
    // 16 November — that is what the calendar will do with the rule we send it.
    //
    // Adding 28 × 86400 seconds instead would land on 09:00, and the check that
    // runs before booking would then be asking about an hour nobody is going to
    // be put in. Written down because the bug is invisible for most of the year.
    const times = localTimes(at("2026-10-19T17:00:00Z"), 4, 3); // 10:00 PT

    expect(times.map((t) => t.date)).toEqual(["2026-10-19", "2026-11-16", "2026-12-14"]);
    expect(times.every((t) => t.time === "10:00")).toBe(true);
  });

  it("counts the session being booked as the first one", () => {
    // "6 sessions" means six in total, not one now and six more later.
    expect(localTimes(at("2026-09-02T17:00:00Z"), 4, 6)).toHaveLength(6);
  });

  it("keeps the weekday", () => {
    // The whole reason the interval is in weeks rather than months: a 1:1 lives
    // on a fixed weekday, and "monthly" would have to choose between the 15th
    // and the first Monday.
    const times = localTimes(at("2026-09-02T17:00:00Z"), 2, 4); // a Wednesday
    expect(times.map((t) => t.date)).toEqual([
      "2026-09-02",
      "2026-09-16",
      "2026-09-30",
      "2026-10-14",
    ]);
  });

  it("carries the duration onto every occurrence", () => {
    const occurrences = occurrenceTimes({
      startUnix: at("2026-09-02T17:00:00Z"),
      durationMinutes: 15,
      recurrence: { intervalWeeks: 4, count: null },
      count: 3,
      timezone: ZONE,
    });
    expect(occurrences.every((o) => o.endUnix - o.startUnix === 15 * 60)).toBe(true);
  });
});

describe("reading a rule back", () => {
  it("understands the rules this app writes", () => {
    expect(parseRecurrence("RRULE:FREQ=WEEKLY;INTERVAL=4;COUNT=6")).toEqual({
      freq: "weekly",
      intervalWeeks: 4,
      count: 6,
    });
  });

  it("treats a missing COUNT as a series with no end", () => {
    // What a standing 1:1 is. Null rather than a large number, so nothing
    // downstream mistakes "forever" for "520 times".
    expect(parseRecurrence("RRULE:FREQ=WEEKLY;INTERVAL=2")).toEqual({
      freq: "weekly",
      intervalWeeks: 2,
      count: null,
    });
  });

  it("understands a monthly rule too", () => {
    expect(parseRecurrence("RRULE:FREQ=MONTHLY;BYDAY=2TU")).toEqual({
      freq: "monthly",
      ordinal: 2,
      weekday: 2,
      count: null,
    });
    expect(parseRecurrence("RRULE:FREQ=MONTHLY;BYDAY=-1FR;COUNT=6")).toEqual({
      freq: "monthly",
      ordinal: -1,
      weekday: 5,
      count: 6,
    });
  });

  it("refuses a rule it did not write", () => {
    // Somebody editing the series in Google to repeat on the 15th of the month,
    // or on three weekdays at once, produces a rule this app cannot reason
    // about. Null means "don't reason about the later dates", which is the safe
    // answer — half-understanding a rule would put conflict warnings on dates
    // that aren't in the series.
    expect(parseRecurrence("RRULE:FREQ=MONTHLY;BYMONTHDAY=15")).toBeNull();
    expect(parseRecurrence("RRULE:FREQ=DAILY")).toBeNull();
    expect(parseRecurrence(null)).toBeNull();
    expect(parseRecurrence("")).toBeNull();
  });

  it("writes back exactly what it reads", () => {
    // The rule string and the parser are each other's only check. Written in
    // one place so a series cannot be created under one meaning and expanded
    // under another.
    for (const rule of [
      "RRULE:FREQ=WEEKLY;INTERVAL=4;COUNT=6",
      "RRULE:FREQ=WEEKLY;INTERVAL=2",
      "RRULE:FREQ=MONTHLY;BYDAY=4FR;COUNT=12",
      "RRULE:FREQ=MONTHLY;BYDAY=-1FR",
    ]) {
      expect(recurrenceRuleString(parseRecurrence(rule)!)).toBe(rule);
    }
  });
});

describe("monthly, the way a calendar means it", () => {
  const ZONE_START = at("2026-08-28T21:30:00Z"); // Fri 28 Aug, 14:30 PT

  function datesOf(recurrence: Parameters<typeof occurrenceTimes>[0]["recurrence"], count: number) {
    return occurrenceTimes({
      startUnix: ZONE_START,
      durationMinutes: 30,
      recurrence,
      count,
      timezone: ZONE,
    }).map((o) => zonedDateTimeParts(o.startUnix, ZONE).date);
  }

  it("drifts out of the month when the rule is every four weeks", () => {
    // Not a bug, and the reason the monthly rules below exist. 28 days is not a
    // month: a session on the last Friday of August is the third Friday of
    // November. Anybody who said "monthly" did not mean this.
    expect(datesOf({ intervalWeeks: 4, count: null }, 4)).toEqual([
      "2026-08-28",
      "2026-09-25",
      "2026-10-23",
      "2026-11-20",
    ]);
  });

  it("holds the last Friday, whatever the date", () => {
    // October 2026 has five Fridays, so this one jumps five weeks rather than
    // four. Keeping its place in the month and keeping its spacing are the two
    // things a rhythm cannot do at once.
    expect(datesOf({ freq: "monthly", ordinal: -1, weekday: 5, count: null }, 4)).toEqual([
      "2026-08-28",
      "2026-09-25",
      "2026-10-30",
      "2026-11-27",
    ]);
  });

  it("holds the fourth Friday, which is not always the last", () => {
    expect(datesOf({ freq: "monthly", ordinal: 4, weekday: 5, count: null }, 4)).toEqual([
      "2026-08-28",
      "2026-09-25",
      "2026-10-23",
      "2026-11-27",
    ]);
  });

  it("keeps the wall-clock time across a daylight-saving change", () => {
    // Pacific goes back an hour on 1 November. The calendar repeats at the same
    // local time, and so must we.
    const times = occurrenceTimes({
      startUnix: ZONE_START,
      durationMinutes: 30,
      recurrence: { freq: "monthly", ordinal: -1, weekday: 5, count: null },
      count: 4,
      timezone: ZONE,
    }).map((o) => zonedDateTimeParts(o.startUnix, ZONE).time);
    expect(new Set(times)).toEqual(new Set(["14:30"]));
  });

  it("describes where a date sits, the way the dialog has to say it", () => {
    // 28 August 2026 is both the fourth Friday and the last one, so both
    // options are offered — which is what Google does.
    expect(monthlyPositionOf("2026-08-28")).toEqual({ weekday: 5, ordinal: 4, isLast: true });
    // 23 October is the fourth Friday of five, so "last" would be wrong.
    expect(monthlyPositionOf("2026-10-23")).toEqual({ weekday: 5, ordinal: 4, isLast: false });
  });
});

describe("the dates of an endless series", () => {
  const seriesStart = at("2026-09-02T17:00:00Z"); // Wed 10:00 PT

  it("returns only the dates inside the window", () => {
    const found = occurrencesBetween({
      seriesStartUnix: seriesStart,
      durationMinutes: 30,
      recurrence: { intervalWeeks: 4, count: null },
      timezone: ZONE,
      fromUnix: at("2026-10-01T00:00:00Z"),
      toUnix: at("2026-12-01T00:00:00Z"),
    });
    // Series runs 02.09, 30.09, 28.10, 25.11, 23.12 — the window catches two.
    expect(found.map((o) => zonedDateTimeParts(o.startUnix, ZONE).date)).toEqual([
      "2026-10-28",
      "2026-11-25",
    ]);
  });

  it("holds the wall-clock time across the daylight-saving change", () => {
    // The same trap as the booking-time maths: 2026-11-01 is the change in
    // Pacific time, and seconds arithmetic would report 09:00 for a call the
    // calendar puts at 10:00 — so the check would look at the wrong hour and
    // either miss a clash or invent one.
    const found = occurrencesBetween({
      seriesStartUnix: seriesStart,
      durationMinutes: 30,
      recurrence: { intervalWeeks: 4, count: null },
      timezone: ZONE,
      fromUnix: seriesStart,
      toUnix: at("2027-01-01T00:00:00Z"),
    });
    expect(found.every((o) => zonedDateTimeParts(o.startUnix, ZONE).time === "10:00")).toBe(true);
  });

  it("stops at COUNT for a series that does end", () => {
    const found = occurrencesBetween({
      seriesStartUnix: seriesStart,
      durationMinutes: 30,
      recurrence: { intervalWeeks: 4, count: 3 },
      timezone: ZONE,
      fromUnix: seriesStart,
      toUnix: at("2028-01-01T00:00:00Z"),
    });
    expect(found).toHaveLength(3);
  });

  it("returns nothing for a window the series has already passed", () => {
    const found = occurrencesBetween({
      seriesStartUnix: seriesStart,
      durationMinutes: 30,
      recurrence: { intervalWeeks: 4, count: 2 },
      timezone: ZONE,
      fromUnix: at("2027-06-01T00:00:00Z"),
      toUnix: at("2027-07-01T00:00:00Z"),
    });
    expect(found).toEqual([]);
  });
});
