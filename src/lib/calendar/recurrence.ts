import { zonedDateTimeParts, zonedDateTimeToUnix, addDaysToDateString } from "@/lib/time";

/** When a repeating session actually falls.
 *
 * Everything here walks LOCAL DATES rather than adding 28 × 86400 seconds. A
 * fortnightly or four-weekly session crosses a daylight-saving boundary sooner
 * or later, and arithmetic on seconds would quietly move a ten o'clock call to
 * nine. The provider repeats at the same wall-clock time; anything reasoning
 * about those dates has to agree, or it reasons about an hour nobody will be
 * booked into. */

/** The subset of RFC 5545 this app writes, in the two shapes Google offers for
 * a session on a given weekday.
 *
 * `weekly` is a fixed weekday every N weeks. Its dates drift against the
 * calendar month, because four weeks is 28 days and a month is not: a session
 * on the last Friday of August is the third Friday of November. That is correct
 * behaviour for "every four weeks" and the wrong behaviour for anyone who meant
 * "monthly", which is why the second shape exists.
 *
 * `monthly` pins the position instead: the fourth Friday, or the last Friday,
 * whatever the date. The gap between two of them is then four weeks or five,
 * which is the unavoidable other side of the same coin — a rhythm can keep its
 * spacing or its place in the month, never both.
 *
 * `count` is null for a series with no end, which is what a standing 1:1 is. */
export type Recurrence =
  | { freq?: "weekly"; intervalWeeks: number; count: number | null }
  | {
      freq: "monthly";
      /** 1–4, or -1 for "the last one in the month" — the same set Google
       * offers. Deliberately no "fifth": months that have one are the exception,
       * and a rule that silently skips most months is not what anybody picked. */
      ordinal: 1 | 2 | 3 | 4 | -1;
      /** 0 = Sunday, matching Date#getUTCDay. */
      weekday: number;
      count: number | null;
    };

/** RFC 5545 weekday codes, in the order the spec numbers them. */
const WEEKDAY_CODES = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"] as const;

/** The RRULE string for a rule, as handed to Google or Microsoft. One place, so
 * what we write and what we read back can never drift apart. */
export function recurrenceRuleString(recurrence: Recurrence): string {
  const end = recurrence.count === null ? "" : `;COUNT=${recurrence.count}`;
  if (recurrence.freq === "monthly") {
    return `RRULE:FREQ=MONTHLY;BYDAY=${recurrence.ordinal}${WEEKDAY_CODES[recurrence.weekday]}${end}`;
  }
  return `RRULE:FREQ=WEEKLY;INTERVAL=${recurrence.intervalWeeks}${end}`;
}

/** Reads back a rule this app produced.
 *
 * Deliberately narrow: the two shapes above and nothing else. A rule we did not
 * write — someone editing the series in Google to repeat on weekdays only, say —
 * is not something to half-understand. Null means "don't reason about the later
 * dates", which is the safe answer everywhere this is used. */
export function parseRecurrence(rule: string | null | undefined): Recurrence | null {
  if (!rule) return null;
  const body = rule.replace(/^RRULE:/i, "");

  const countRaw = /(?:^|;)COUNT=(\d+)/i.exec(body)?.[1];
  const count = countRaw === undefined ? null : Number(countRaw);
  if (count !== null && (!Number.isInteger(count) || count < 1)) return null;

  if (/(^|;)FREQ=MONTHLY(;|$)/i.test(body)) {
    const byDay = /(?:^|;)BYDAY=(-?\d)([A-Z]{2})/i.exec(body);
    // A monthly rule without BYDAY is one keyed to the day of the month, which
    // this app does not write. Not guessed at.
    if (!byDay) return null;
    const ordinal = Number(byDay[1]);
    if (![1, 2, 3, 4, -1].includes(ordinal)) return null;
    const weekday = WEEKDAY_CODES.indexOf(byDay[2].toUpperCase() as (typeof WEEKDAY_CODES)[number]);
    if (weekday < 0) return null;
    return { freq: "monthly", ordinal: ordinal as 1 | 2 | 3 | 4 | -1, weekday, count };
  }

  if (!/(^|;)FREQ=WEEKLY(;|$)/i.test(body)) return null;
  const interval = Number(/(?:^|;)INTERVAL=(\d+)/i.exec(body)?.[1] ?? "1");
  if (!Number.isInteger(interval) || interval < 1 || interval > 52) return null;
  return { freq: "weekly", intervalWeeks: interval, count };
}

/** Which weekday and which position in the month a date sits at.
 *
 * What the dialog needs to say "monthly on the fourth Friday" for the date
 * somebody just picked — the same sentence Google puts in its own dropdown,
 * built from the same two numbers. `isLast` is separate from `ordinal` because
 * a date can be both, and offering both is what Google does. */
export function monthlyPositionOf(dateString: string): {
  weekday: number;
  ordinal: 1 | 2 | 3 | 4 | 5;
  isLast: boolean;
} {
  const [year, month, day] = dateString.split("-").map(Number);
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  const ordinal = Math.ceil(day / 7) as 1 | 2 | 3 | 4 | 5;
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return { weekday, ordinal, isLast: day + 7 > daysInMonth };
}

/** The date of the Nth (or last) given weekday in a month, or null when the
 * month has no such day. */
function nthWeekdayOfMonth(
  year: number,
  monthIndex: number,
  weekday: number,
  ordinal: number
): string | null {
  const daysInMonth = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
  const matches: number[] = [];
  for (let day = 1; day <= daysInMonth; day++) {
    if (new Date(Date.UTC(year, monthIndex, day)).getUTCDay() === weekday) matches.push(day);
  }
  const day = ordinal === -1 ? matches[matches.length - 1] : matches[ordinal - 1];
  if (day === undefined) return null;
  const mm = String(monthIndex + 1).padStart(2, "0");
  const dd = String(day).padStart(2, "0");
  return `${year}-${mm}-${dd}`;
}

/** The series' dates as local date strings, in order, starting from its first.
 *
 * The single place either shape is expanded. Everything else — the pre-booking
 * check, the grid, the daily conflict look-ahead, the 1:1 dates — goes through
 * one of the two functions below and therefore through this. */
function seriesDates(firstDate: string, recurrence: Recurrence, limit: number): string[] {
  if (recurrence.freq === "monthly") {
    const [year, month] = firstDate.split("-").map(Number);
    const out: string[] = [];
    for (let i = 0; i < limit; i++) {
      const absolute = month - 1 + i;
      const date = nthWeekdayOfMonth(
        year + Math.floor(absolute / 12),
        ((absolute % 12) + 12) % 12,
        recurrence.weekday,
        recurrence.ordinal
      );
      // Only reachable for an ordinal a month cannot satisfy, which the type
      // above rules out. Skipped rather than ending the series.
      if (date) out.push(date);
    }
    return out;
  }
  return Array.from({ length: limit }, (_, i) =>
    addDaysToDateString(firstDate, i * recurrence.intervalWeeks * 7)
  );
}

/** The first `count` dates of a series, starting with the one being booked.
 *
 * A count of 6 means six sessions in total, not six more. */
export function occurrenceTimes(params: {
  startUnix: number;
  durationMinutes: number;
  recurrence: Recurrence;
  count: number;
  timezone: string;
}): { startUnix: number; endUnix: number }[] {
  const first = zonedDateTimeParts(params.startUnix, params.timezone);
  const out: { startUnix: number; endUnix: number }[] = [];
  for (const date of seriesDates(first.date, params.recurrence, params.count)) {
    const startUnix = zonedDateTimeToUnix(date, first.time, params.timezone);
    if (!Number.isFinite(startUnix)) continue;
    out.push({ startUnix, endUnix: startUnix + params.durationMinutes * 60 });
  }
  return out;
}

/** Every date of a series that falls inside a window.
 *
 * This is what a series with no end needs: you cannot ask for "all of them", so
 * you ask for the ones near enough to matter. The daily check looks a couple of
 * months ahead — far enough that a clash can still be moved without an apology,
 * near enough that it isn't chasing dates nobody has planned around yet.
 *
 * Bounded by a hard iteration cap as well as by the window, so a malformed rule
 * cannot spin. */
export function occurrencesBetween(params: {
  /** The series' first session — `events.starts_at`. */
  seriesStartUnix: number;
  durationMinutes: number;
  recurrence: Recurrence;
  timezone: string;
  fromUnix: number;
  toUnix: number;
}): { startUnix: number; endUnix: number }[] {
  const first = zonedDateTimeParts(params.seriesStartUnix, params.timezone);
  // Ten years either way, as a backstop — monthly needs far fewer steps than
  // weekly to reach the same horizon.
  const backstop = params.recurrence.freq === "monthly" ? 120 : 520;
  const limit = params.recurrence.count ?? backstop;

  const out: { startUnix: number; endUnix: number }[] = [];
  for (const date of seriesDates(first.date, params.recurrence, limit)) {
    const startUnix = zonedDateTimeToUnix(date, first.time, params.timezone);
    if (!Number.isFinite(startUnix)) continue;
    if (startUnix > params.toUnix) break;
    if (startUnix >= params.fromUnix) {
      out.push({ startUnix, endUnix: startUnix + params.durationMinutes * 60 });
    }
  }
  return out;
}
