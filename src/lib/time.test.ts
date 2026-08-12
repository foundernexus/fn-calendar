import { describe, it, expect } from "vitest";
import {
  dayOfWeek,
  isValidDateString,
  isValidTimeString,
  isOnIntervalBoundary,
  zonedDateTimeToUnix,
  zonedDateTimeParts,
  addDaysToDateString,
  nextDayString,
  isWeekendDateString,
  generateTimeRows,
  formatTimeLabel,
  slotMatchesMemberAvailability,
  weekStartDateString,
  slotWithinWeeklyCap,
} from "./time";

describe("dayOfWeek", () => {
  it("returns 0 for Sunday and 6 for Saturday", () => {
    // 2026-08-16 is a Sunday, 2026-08-22 is a Saturday.
    expect(dayOfWeek("2026-08-16")).toBe(0);
    expect(dayOfWeek("2026-08-22")).toBe(6);
  });

  it("returns 1 for a known Monday", () => {
    expect(dayOfWeek("2026-08-17")).toBe(1);
  });
});

describe("isValidDateString", () => {
  it("accepts a real calendar date", () => {
    expect(isValidDateString("2026-08-17")).toBe(true);
  });

  it("rejects an impossible date instead of silently rolling over", () => {
    // Feb 30 doesn't exist — Date would otherwise silently roll this into
    // March 2nd if we didn't check the round-trip.
    expect(isValidDateString("2026-02-30")).toBe(false);
  });

  it("rejects malformed shapes", () => {
    expect(isValidDateString("2026-8-17")).toBe(false);
    expect(isValidDateString("not-a-date")).toBe(false);
  });
});

describe("isValidTimeString", () => {
  it("accepts valid 24h times", () => {
    expect(isValidTimeString("00:00")).toBe(true);
    expect(isValidTimeString("23:59")).toBe(true);
    expect(isValidTimeString("09:30")).toBe(true);
  });

  it("rejects out-of-range or malformed times", () => {
    expect(isValidTimeString("24:00")).toBe(false);
    expect(isValidTimeString("12:60")).toBe(false);
    expect(isValidTimeString("9:30")).toBe(false);
  });
});

describe("isOnIntervalBoundary", () => {
  it("accepts times on the 30-minute grid", () => {
    expect(isOnIntervalBoundary("09:00")).toBe(true);
    expect(isOnIntervalBoundary("09:30")).toBe(true);
  });

  it("rejects times off the grid", () => {
    expect(isOnIntervalBoundary("09:15")).toBe(false);
  });
});

describe("addDaysToDateString / nextDayString", () => {
  it("handles ordinary day rollover", () => {
    expect(addDaysToDateString("2026-08-17", 1)).toBe("2026-08-18");
    expect(nextDayString("2026-08-17")).toBe("2026-08-18");
  });

  it("handles month rollover", () => {
    expect(addDaysToDateString("2026-08-31", 1)).toBe("2026-09-01");
  });

  it("handles year rollover", () => {
    expect(addDaysToDateString("2026-12-31", 1)).toBe("2027-01-01");
  });

  it("handles negative offsets", () => {
    expect(addDaysToDateString("2026-08-01", -1)).toBe("2026-07-31");
  });
});

describe("isWeekendDateString", () => {
  it("flags Saturday and Sunday", () => {
    expect(isWeekendDateString("2026-08-22")).toBe(true);
    expect(isWeekendDateString("2026-08-16")).toBe(true);
  });

  it("does not flag weekdays", () => {
    expect(isWeekendDateString("2026-08-17")).toBe(false);
  });
});

describe("zonedDateTimeToUnix / zonedDateTimeParts round trip", () => {
  it("round-trips a wall-clock time through a timezone correctly", () => {
    const unix = zonedDateTimeToUnix("2026-08-17", "14:00", "America/Los_Angeles");
    const parts = zonedDateTimeParts(unix, "America/Los_Angeles");
    expect(parts.date).toBe("2026-08-17");
    expect(parts.time).toBe("14:00");
  });

  it("the same wall-clock instant reads differently in a different timezone", () => {
    const unix = zonedDateTimeToUnix("2026-08-17", "14:00", "America/Los_Angeles");
    const nyParts = zonedDateTimeParts(unix, "America/New_York");
    // PT is 3 hours behind ET in August (both observe DST).
    expect(nyParts.time).toBe("17:00");
    expect(nyParts.date).toBe("2026-08-17");
  });
});

describe("generateTimeRows", () => {
  it("steps by the 30-minute interval, excluding the end boundary", () => {
    const rows = generateTimeRows("09:00", "10:30");
    expect(rows).toEqual(["09:00", "09:30", "10:00"]);
  });

  it("returns an empty list when start equals end", () => {
    expect(generateTimeRows("09:00", "09:00")).toEqual([]);
  });
});

describe("formatTimeLabel", () => {
  it("formats midnight and noon correctly", () => {
    expect(formatTimeLabel("00:00")).toBe("12:00 AM");
    expect(formatTimeLabel("12:00")).toBe("12:00 PM");
  });

  it("formats ordinary AM/PM times", () => {
    expect(formatTimeLabel("09:30")).toBe("9:30 AM");
    expect(formatTimeLabel("14:00")).toBe("2:00 PM");
  });
});

describe("slotMatchesMemberAvailability", () => {
  const monday9to5 = [{ dayOfWeek: 1, startTime: "09:00", endTime: "17:00" }];
  // 2026-08-17 is a Monday. 2pm-3pm PT.
  const mondaySlot = {
    startUnix: zonedDateTimeToUnix("2026-08-17", "14:00", "America/Los_Angeles"),
    endUnix: zonedDateTimeToUnix("2026-08-17", "15:00", "America/Los_Angeles"),
  };

  it("allows a slot inside the stated window", () => {
    expect(slotMatchesMemberAvailability(mondaySlot, "America/Los_Angeles", monday9to5)).toBe(
      true
    );
  });

  it("rejects a slot outside the stated window on a day that has one", () => {
    const earlySlot = {
      startUnix: zonedDateTimeToUnix("2026-08-17", "07:00", "America/Los_Angeles"),
      endUnix: zonedDateTimeToUnix("2026-08-17", "08:00", "America/Los_Angeles"),
    };
    expect(slotMatchesMemberAvailability(earlySlot, "America/Los_Angeles", monday9to5)).toBe(
      false
    );
  });

  it("rejects a slot on a day with no row at all (explicit day off)", () => {
    // 2026-08-18 is a Tuesday — no row for it in monday9to5.
    const tuesdaySlot = {
      startUnix: zonedDateTimeToUnix("2026-08-18", "14:00", "America/Los_Angeles"),
      endUnix: zonedDateTimeToUnix("2026-08-18", "15:00", "America/Los_Angeles"),
    };
    expect(slotMatchesMemberAvailability(tuesdaySlot, "America/Los_Angeles", monday9to5)).toBe(
      false
    );
  });

  it("is unrestricted when the member has never set a timezone (never touched /me)", () => {
    expect(slotMatchesMemberAvailability(mondaySlot, null, [])).toBe(true);
    // Even a slot on a day they'd otherwise be "off" is allowed, since they
    // never engaged with availability setup at all.
    const tuesdaySlot = {
      startUnix: zonedDateTimeToUnix("2026-08-18", "03:00", "America/Los_Angeles"),
      endUnix: zonedDateTimeToUnix("2026-08-18", "04:00", "America/Los_Angeles"),
    };
    expect(slotMatchesMemberAvailability(tuesdaySlot, null, [])).toBe(true);
  });

  it("rejects EVERY day when the member has a timezone set but zero rows (explicitly turned every day off)", () => {
    // This is the exact bug caught by review before it shipped: a saved
    // timezone with no rows must NOT be treated the same as "never saved."
    expect(slotMatchesMemberAvailability(mondaySlot, "America/Los_Angeles", [])).toBe(false);
  });

  it("checks the window in the member's OWN timezone, not the slot's origin timezone", () => {
    // A slot that's 2-3pm Pacific is 5-6pm Eastern. A member in New York
    // with a 9-5 Monday window (their own local time) should accept it,
    // since 5-6pm ET falls outside 9am-5pm ET... wait — 5pm is the boundary.
    // Use a slot that's clearly inside when read in the member's own zone.
    const earlyPacificSlot = {
      // 9am Pacific = 12pm Eastern — inside a 9-5 Eastern window.
      startUnix: zonedDateTimeToUnix("2026-08-17", "09:00", "America/Los_Angeles"),
      endUnix: zonedDateTimeToUnix("2026-08-17", "10:00", "America/Los_Angeles"),
    };
    expect(
      slotMatchesMemberAvailability(earlyPacificSlot, "America/New_York", monday9to5)
    ).toBe(true);

    // A slot that's 9-10am Pacific is midnight-1am Eastern the SAME night —
    // outside a 9-5 Eastern Monday window entirely.
    // Use one clearly outside instead: 6-7am Pacific = 9-10am Eastern is
    // actually inside, so pick 4-5am Pacific = 7-8am Eastern, before the window.
    const tooEarlyForEastern = {
      startUnix: zonedDateTimeToUnix("2026-08-17", "04:00", "America/Los_Angeles"),
      endUnix: zonedDateTimeToUnix("2026-08-17", "05:00", "America/Los_Angeles"),
    };
    expect(
      slotMatchesMemberAvailability(tooEarlyForEastern, "America/New_York", monday9to5)
    ).toBe(false);
  });

  it("allows a slot ending exactly at the window's end time (boundary inclusive)", () => {
    const endsAtFive = {
      startUnix: zonedDateTimeToUnix("2026-08-17", "16:00", "America/Los_Angeles"),
      endUnix: zonedDateTimeToUnix("2026-08-17", "17:00", "America/Los_Angeles"),
    };
    expect(slotMatchesMemberAvailability(endsAtFive, "America/Los_Angeles", monday9to5)).toBe(
      true
    );
  });

  it("rejects a slot that spans midnight in the member's own zone", () => {
    const overnightWindow = [{ dayOfWeek: 1, startTime: "22:00", endTime: "23:30" }];
    const spansMidnight = {
      startUnix: zonedDateTimeToUnix("2026-08-17", "23:45", "America/Los_Angeles"),
      endUnix: zonedDateTimeToUnix("2026-08-18", "00:15", "America/Los_Angeles"),
    };
    expect(
      slotMatchesMemberAvailability(spansMidnight, "America/Los_Angeles", overnightWindow)
    ).toBe(false);
  });
});

describe("weekStartDateString", () => {
  it("returns the same Sunday for every day in that week", () => {
    // 2026-08-16 is a Sunday, 2026-08-22 is the following Saturday.
    expect(weekStartDateString("2026-08-16")).toBe("2026-08-16");
    expect(weekStartDateString("2026-08-17")).toBe("2026-08-16");
    expect(weekStartDateString("2026-08-22")).toBe("2026-08-16");
  });

  it("returns a different week start for the following Sunday", () => {
    expect(weekStartDateString("2026-08-23")).toBe("2026-08-23");
  });

  it("handles a week that crosses a month boundary", () => {
    // 2026-08-31 is a Monday; that week started Sunday 2026-08-30.
    expect(weekStartDateString("2026-08-31")).toBe("2026-08-30");
  });
});

describe("slotWithinWeeklyCap", () => {
  const mondaySlot = {
    startUnix: zonedDateTimeToUnix("2026-08-17", "14:00", "America/Los_Angeles"),
  };

  it("allows booking when under the cap", () => {
    const counts = new Map([["2026-08-16", 2]]);
    expect(slotWithinWeeklyCap(mondaySlot, "America/Los_Angeles", 5, counts)).toBe(true);
  });

  it("rejects booking when already at the cap", () => {
    const counts = new Map([["2026-08-16", 5]]);
    expect(slotWithinWeeklyCap(mondaySlot, "America/Los_Angeles", 5, counts)).toBe(false);
  });

  it("rejects booking when already over the cap", () => {
    const counts = new Map([["2026-08-16", 7]]);
    expect(slotWithinWeeklyCap(mondaySlot, "America/Los_Angeles", 5, counts)).toBe(false);
  });

  it("allows any count when the cap is effectively unlimited", () => {
    const counts = new Map([["2026-08-16", 999]]);
    expect(slotWithinWeeklyCap(mondaySlot, "America/Los_Angeles", Infinity, counts)).toBe(true);
  });

  it("a cap of 0 always rejects, regardless of existing count", () => {
    expect(slotWithinWeeklyCap(mondaySlot, "America/Los_Angeles", 0, new Map())).toBe(false);
  });

  it("ignores counts from a different week", () => {
    // All booked into the FOLLOWING week (starting 2026-08-23), not this one.
    const counts = new Map([["2026-08-23", 5]]);
    expect(slotWithinWeeklyCap(mondaySlot, "America/Los_Angeles", 5, counts)).toBe(true);
  });

  it("is unrestricted when the member has no timezone set", () => {
    const counts = new Map([["2026-08-16", 999]]);
    expect(slotWithinWeeklyCap(mondaySlot, null, 5, counts)).toBe(true);
  });

  it("buckets the same instant into a different week depending on the member's own timezone", () => {
    // Sunday 11pm Pacific is already Monday in most zones east of it —
    // different member timezones can legitimately bucket the same instant
    // into different weeks.
    const lateSaturdayPacific = {
      startUnix: zonedDateTimeToUnix("2026-08-22", "23:00", "America/Los_Angeles"),
    };
    // In Pacific time this is still Saturday the 22nd — week of Aug 16.
    const pacificCounts = new Map([["2026-08-16", 5]]);
    expect(slotWithinWeeklyCap(lateSaturdayPacific, "America/Los_Angeles", 5, pacificCounts)).toBe(
      false
    );
    // In Eastern time (3 hours ahead) this has already rolled into Sunday
    // the 23rd — the NEXT week — so a cap already hit for the prior week
    // doesn't apply here.
    const easternCounts = new Map([["2026-08-16", 5]]);
    expect(slotWithinWeeklyCap(lateSaturdayPacific, "America/New_York", 5, easternCounts)).toBe(
      true
    );
  });
});
