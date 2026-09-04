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

/** A candidate time at least one participant is busy for, and whose calendar it
 * is.
 *
 * Never returned by computeCollectiveSlots. That function means "everybody is
 * free" and goes on meaning only that, so nothing downstream starts answering a
 * different question by accident — see the note on CollectiveAvailability.
 *
 * `busyEmails` is grant addresses, the same currency as ParticipantBusy.email,
 * because only the caller knows which member holds which address. */
export type BusyAvailabilitySlot = AvailabilitySlot & { busyEmails: string[] };

/** The window a search asks about — everything except who is in it. */
type SlotWindow = {
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
export function computeCollectiveSlots(
  params: SlotWindow & { participants: ParticipantBusy[] }
): AvailabilitySlot[] {
  // Nobody selected means nothing to offer. Returning "every slot is free"
  // would be technically true and operationally a trap.
  if (params.participants.length === 0) return [];

  const emails = params.participants.map((p) => p.email);
  const busyByEmail = params.participants.map((p) => mergeIntervals(p.busy));

  return candidateSlots(params)
    .filter(({ startTime, endTime }) =>
      busyByEmail.every((busy) => !overlapsBusy(startTime, endTime, busy))
    )
    .map(({ startTime, endTime }) => ({ emails, startTime, endTime }));
}

/** Every candidate slot at least one participant is busy for, naming who.
 *
 * The exact complement of computeCollectiveSlots over the same window: the two
 * partition the candidate set, so a grid drawn from both together has no cell
 * that is neither offered nor explained. That only holds because both walk the
 * same `candidateSlots` — which is why that walk is one function and not two.
 *
 * Exists so an admin can deliberately book over a hold made somewhere else (a
 * Calendly invite, a placeholder). The names are what makes that safe rather
 * than reckless: a cell saying "someone's busy" that takes a click is a trap,
 * one that says whose is a decision. */
export function computeBusySlots(
  params: SlotWindow & { participants: ParticipantBusy[] }
): BusyAvailabilitySlot[] {
  if (params.participants.length === 0) return [];

  const emails = params.participants.map((p) => p.email);
  const busyByEmail = params.participants.map((p) => mergeIntervals(p.busy));

  return candidateSlots(params).flatMap(({ startTime, endTime }) => {
    const busyEmails = emails.filter((_, i) => overlapsBusy(startTime, endTime, busyByEmail[i]));
    return busyEmails.length === 0 ? [] : [{ emails, startTime, endTime, busyEmails }];
  });
}

/** Every slot the grid could draw in this window, free or not, in order.
 *
 * Split out so the two questions asked of a window — "when is everyone free"
 * and "when is somebody busy, and who" — cannot generate different candidates.
 * All of the reasoning above about landing on the rows the grid actually draws
 * holds only while there is exactly one place that decides where a slot starts. */
function candidateSlots(params: SlotWindow): { startTime: number; endTime: number }[] {
  const interval = params.intervalMinutes ?? AVAILABILITY_INTERVAL_MINUTES;
  const durationSeconds = params.durationMinutes * 60;

  const [startH, startM] = params.workingHoursStart.split(":").map(Number);
  const [endH, endM] = params.workingHoursEnd.split(":").map(Number);
  const openStartMinutes = startH * 60 + startM;
  const openEndMinutes = endH * 60 + endM;

  const slots: { startTime: number; endTime: number }[] = [];

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

      slots.push({ startTime: slotStart, endTime: slotEnd });
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
