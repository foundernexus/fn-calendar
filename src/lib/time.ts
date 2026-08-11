import { fromZonedTime, formatInTimeZone } from "date-fns-tz";

/** The only timezones the admin can pick — kept short and curated rather than
 * an exhaustive IANA list, per the lean-V1 scope. Both the find-a-time form's
 * Select and the availability route's zod validation read from this single
 * source of truth so they can never drift out of sync. */
export const TIMEZONES = [
  { value: "America/Los_Angeles", label: "Pacific (PT)" },
  { value: "America/Denver", label: "Mountain (MT)" },
  { value: "America/Chicago", label: "Central (CT)" },
  { value: "America/New_York", label: "Eastern (ET)" },
] as const;

export type TimezoneValue = (typeof TIMEZONES)[number]["value"];

/** True only for a real calendar date in "YYYY-MM-DD" form — rejects
 * impossible dates like 2026-02-30 that the shape-only regex would allow
 * through (which would otherwise silently become NaN downstream and surface
 * as a misleading "couldn't reach Nylas" error). */
export function isValidDateString(dateStr: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return false;
  const [y, m, d] = dateStr.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return (
    date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d
  );
}

/** True for a real "HH:mm" 24-hour time. */
export function isValidTimeString(timeStr: string) {
  if (!/^\d{2}:\d{2}$/.test(timeStr)) return false;
  const [h, m] = timeStr.split(":").map(Number);
  return h >= 0 && h <= 23 && m >= 0 && m <= 59;
}

/** Converts a "YYYY-MM-DD" date + "HH:mm" time, interpreted as wall-clock time
 * in `timezone`, into a unix-seconds timestamp. Used to turn the admin's date
 * range into the UTC window Nylas's availability API expects. Callers must
 * validate `dateStr`/`timeStr` first (isValidDateString/isValidTimeString) —
 * this does not itself guard against malformed input. */
export function zonedDateTimeToUnix(dateStr: string, timeStr: string, timezone: string) {
  const utcDate = fromZonedTime(`${dateStr}T${timeStr}:00`, timezone);
  return Math.floor(utcDate.getTime() / 1000);
}

/** Returns the "YYYY-MM-DD" for the day after `dateStr`. Used to build an
 * end-of-range boundary as the NEXT day's midnight rather than "23:59" —
 * Nylas requires start_time/end_time to be exact multiples of 5 minutes, and
 * while midnight always lands on one (every supported timezone's UTC offset
 * is a whole number of hours), 23:59 never does. */
export function nextDayString(dateStr: string) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d + 1));
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function shortZoneName(date: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    timeZoneName: "short",
  }).formatToParts(date);
  return parts.find((p) => p.type === "timeZoneName")?.value ?? timezone;
}

/** Formats a unix-seconds slot start/end for display in `timezone`, e.g.
 * "Wed Aug 19, 12:00 PM–1:00 PM PDT". Both ends always carry AM/PM — omitting
 * it on the start (as a "12:00–1:00 PM" style would) is ambiguous for any
 * slot crossing noon or midnight. Formats straight from the UTC instant — no
 * intermediate toZonedTime() shift, which would double-convert. */
export function formatSlotRange(startUnix: number, endUnix: number, timezone: string) {
  const start = new Date(startUnix * 1000);
  const end = new Date(endUnix * 1000);

  const datePart = formatInTimeZone(start, timezone, "EEE MMM d");
  const startPart = formatInTimeZone(start, timezone, "h:mm a");
  const endPart = formatInTimeZone(end, timezone, "h:mm a");
  const zonePart = shortZoneName(start, timezone);

  return `${datePart}, ${startPart}–${endPart} ${zonePart}`;
}
