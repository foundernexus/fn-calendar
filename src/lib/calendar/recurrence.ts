import { zonedDateTimeParts, zonedDateTimeToUnix, addDaysToDateString } from "@/lib/time";

/** When a repeating session actually falls.
 *
 * Everything here walks LOCAL DATES rather than adding 28 × 86400 seconds. A
 * fortnightly or four-weekly session crosses a daylight-saving boundary sooner
 * or later, and arithmetic on seconds would quietly move a ten o'clock call to
 * nine. The provider repeats at the same wall-clock time; anything reasoning
 * about those dates has to agree, or it reasons about an hour nobody will be
 * booked into. */

/** The subset of RFC 5545 this app writes. `count` is null for a series with no
 * end, which is what a standing 1:1 is. */
export type Recurrence = { intervalWeeks: number; count: number | null };

/** Reads back a rule this app produced.
 *
 * Deliberately narrow: it understands `FREQ=WEEKLY` with an interval and an
 * optional count, and returns null for anything else. A rule we did not write —
 * someone editing the series in Google to repeat on the second Tuesday, say —
 * is not something to half-understand. Null means "don't reason about the later
 * dates", which is the safe answer. */
export function parseRecurrence(rule: string | null | undefined): Recurrence | null {
  if (!rule) return null;
  const body = rule.replace(/^RRULE:/i, "");
  if (!/(^|;)FREQ=WEEKLY(;|$)/i.test(body)) return null;
  const interval = Number(/(?:^|;)INTERVAL=(\d+)/i.exec(body)?.[1] ?? "1");
  if (!Number.isInteger(interval) || interval < 1 || interval > 52) return null;
  const countRaw = /(?:^|;)COUNT=(\d+)/i.exec(body)?.[1];
  const count = countRaw === undefined ? null : Number(countRaw);
  if (count !== null && (!Number.isInteger(count) || count < 1)) return null;
  return { intervalWeeks: interval, count };
}

/** The first `count` dates of a series, starting with the one being booked.
 *
 * A count of 6 means six sessions in total, not six more. */
export function occurrenceTimes(params: {
  startUnix: number;
  durationMinutes: number;
  intervalWeeks: number;
  count: number;
  timezone: string;
}): { startUnix: number; endUnix: number }[] {
  const first = zonedDateTimeParts(params.startUnix, params.timezone);
  const out: { startUnix: number; endUnix: number }[] = [];
  for (let i = 0; i < params.count; i++) {
    const date = addDaysToDateString(first.date, i * params.intervalWeeks * 7);
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
  const out: { startUnix: number; endUnix: number }[] = [];
  const limit = params.recurrence.count ?? 520; // ten years of weekly, as a backstop

  for (let i = 0; i < limit; i++) {
    const date = addDaysToDateString(first.date, i * params.recurrence.intervalWeeks * 7);
    const startUnix = zonedDateTimeToUnix(date, first.time, params.timezone);
    if (!Number.isFinite(startUnix)) continue;
    if (startUnix > params.toUnix) break;
    if (startUnix >= params.fromUnix) {
      out.push({ startUnix, endUnix: startUnix + params.durationMinutes * 60 });
    }
  }
  return out;
}
