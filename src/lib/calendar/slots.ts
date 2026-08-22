import {
  zonedDateTimeToUnix,
  zonedDateTimeParts,
  addDaysToDateString,
  isWeekendDateString,
  AVAILABILITY_INTERVAL_MINUTES,
} from "@/lib/time";

/** A busy period on somebody's calendar, in unix seconds. Half-open: a block
 * ending at 10:00 does not collide with a slot starting at 10:00, which is how
 * both Google and Microsoft report them and what people expect from
 * back-to-back meetings. */
export type BusyInterval = { start: number; end: number };

export type ParticipantBusy = {
  /** The address the calendar was connected under — NOT members.email. The two
   * differ often enough (a personal Gmail against a work address) that mixing
   * them up silently returns the wrong person's availability. */
  email: string;
  busy: BusyInterval[];
};

export type AvailabilitySlot = {
  emails: string[];
  startTime: number;
  endTime: number;
};

/** Sorts and coalesces overlapping or touching intervals.
 *
 * Providers happily return overlapping blocks — two calendars in one account,
 * an event inside another event — and merging first means the collision check
 * below is a simple scan instead of an accidental O(n²) with duplicate work. */
export function mergeIntervals(intervals: BusyInterval[]): BusyInterval[] {
  if (intervals.length === 0) return [];
  const sorted = [...intervals].sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: BusyInterval[] = [{ ...sorted[0] }];
  for (const next of sorted.slice(1)) {
    const last = merged[merged.length - 1];
    // `<=` so [9,10] and [10,11] become [9,11]: as a *busy* span they are
    // continuous, even though a slot may legitimately start exactly at 10.
    if (next.start <= last.end) last.end = Math.max(last.end, next.end);
    else merged.push({ ...next });
  }
  return merged;
}

/** True when [start, end) touches any busy block. Assumes `busy` is merged and
 * sorted, so it can stop at the first block that starts after the slot. */
function overlapsBusy(start: number, end: number, busy: BusyInterval[]) {
  for (const block of busy) {
    if (block.start >= end) return false;
    if (block.end > start) return true;
  }
  return false;
}

/** Every slot inside the requested window where EVERY participant is free.
 *
 * This replaces what Nylas's collective availability query did for us, and it
 * has to agree with the grid exactly: src/components/availability-grid.tsx
 * builds its rows by stepping from workingHoursStart in intervalMinutes
 * increments, so a slot on any other boundary lands between rows and silently
 * fails to render. Candidates are therefore generated on that same grid rather
 * than derived from where people happen to be free.
 *
 * Working hours are wall-clock times in `timezone`, evaluated per calendar day
 * — not a fixed offset applied once. That matters across a DST change, where
 * the same 09:00 is a different number of seconds from midnight before and
 * after.
 *
 * Note what is NOT done here: each member's own weekly availability. That is
 * applied afterwards by slotMatchesMemberAvailability() in src/lib/time.ts,
 * exactly as it was when Nylas produced these slots. This function answers the
 * coarser question — "is everyone's calendar clear?" */
export function computeCollectiveSlots(params: {
  participants: ParticipantBusy[];
  /** Window to search, unix seconds. */
  startTime: number;
  endTime: number;
  durationMinutes: number;
  intervalMinutes?: number;
  timezone: string;
  /** "HH:mm" wall-clock bounds in `timezone`. */
  workingHoursStart: string;
  workingHoursEnd: string;
  excludeWeekends: boolean;
}): AvailabilitySlot[] {
  const interval = params.intervalMinutes ?? AVAILABILITY_INTERVAL_MINUTES;
  const durationSeconds = params.durationMinutes * 60;
  const emails = params.participants.map((p) => p.email);

  // Nobody selected means nothing to offer. Returning "every slot is free"
  // would be technically true and operationally a trap.
  if (params.participants.length === 0) return [];

  const busyByEmail = params.participants.map((p) => mergeIntervals(p.busy));

  const [startH, startM] = params.workingHoursStart.split(":").map(Number);
  const [endH, endM] = params.workingHoursEnd.split(":").map(Number);
  const openStartMinutes = startH * 60 + startM;
  const openEndMinutes = endH * 60 + endM;

  const slots: AvailabilitySlot[] = [];

  // Walk calendar days in the target timezone. Starting one day early and
  // ending one day late costs two wasted iterations and removes a whole class
  // of off-by-one: a window that begins at 23:00 UTC belongs to the *previous*
  // local day in western timezones, and candidates on that day would otherwise
  // never be generated.
  let date = addDaysToDateString(zonedDateTimeParts(params.startTime, params.timezone).date, -1);
  const lastDate = addDaysToDateString(zonedDateTimeParts(params.endTime, params.timezone).date, 1);

  while (date <= lastDate) {
    if (params.excludeWeekends && isWeekendDateString(date)) {
      date = addDaysToDateString(date, 1);
      continue;
    }

    for (let m = openStartMinutes; m + params.durationMinutes <= openEndMinutes; m += interval) {
      const timeStr = `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
      const slotStart = zonedDateTimeToUnix(date, timeStr, params.timezone);
      const slotEnd = slotStart + durationSeconds;

      // The window is the hard boundary; a session may not begin before it or
      // run past its end.
      if (slotStart < params.startTime || slotEnd > params.endTime) continue;

      if (busyByEmail.every((busy) => !overlapsBusy(slotStart, slotEnd, busy))) {
        slots.push({ emails, startTime: slotStart, endTime: slotEnd });
      }
    }

    date = addDaysToDateString(date, 1);
  }

  // Chronological, and de-duplicated on start time — the day-either-side walk
  // above can generate the same wall-clock slot twice when a DST shift makes a
  // local time occur on two UTC instants.
  slots.sort((a, b) => a.startTime - b.startTime);
  return slots.filter((slot, i) => i === 0 || slot.startTime !== slots[i - 1].startTime);
}

/** One entry from the signed-in person's own calendar, title included.
 *
 * That title is the whole difference from BusyInterval, and the reason this is
 * only ever fetched for the person looking at the screen: free/busy is all we
 * ask of anyone else, and all we take. */
export type OwnEvent = { start: number; end: number; title: string; allDay: boolean };
