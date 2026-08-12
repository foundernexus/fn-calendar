/** Member-facing timezone support — deliberately separate from the curated
 * 4-zone `TIMEZONES` list in src/lib/time.ts (that one's scoped to the
 * admin's find-a-time search over a small set of US zones; members can be
 * anywhere in the world). Built from the real IANA database at runtime
 * rather than a hand-maintained list, so it's always complete and correct. */

/** "Europe/Berlin" -> "Berlin — GMT+2". The offset reflects the current date
 * (DST-aware), so it can shift twice a year for zones that observe it —
 * expected, not a bug. Search in the UI matches the IANA string's embedded
 * city/region name, not country names (e.g. "Berlin" works, "Germany"
 * doesn't) — a known, accepted limitation for V2. */
export function timezoneLabel(tz: string): string {
  const city = tz.split("/").pop()?.replace(/_/g, " ") ?? tz;
  const offset = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    timeZoneName: "shortOffset",
  })
    .formatToParts(new Date())
    .find((p) => p.type === "timeZoneName")?.value;
  return offset ? `${city} — ${offset}` : city;
}

/** Computed once at module load, not per-render — `timezoneLabel` does a
 * real Intl.DateTimeFormat construction per zone, expensive enough (~100ms
 * for the full ~400-zone list) to matter if it ran on every keystroke in the
 * settings form instead of once here. */
export const TIMEZONE_OPTIONS: readonly { tz: string; label: string }[] =
  Intl.supportedValuesOf("timeZone").map((tz) => ({ tz, label: timezoneLabel(tz) }));

/** Validates by whether the runtime can actually construct a formatter for
 * `tz`, not by membership in `Intl.supportedValuesOf("timeZone")` — that
 * list is ICU-version-dependent, and the browser's ICU and the server's ICU
 * can legitimately disagree on which of two aliases for the same zone
 * (e.g. "Asia/Kolkata" vs. the older "Asia/Calcutta") is the canonical
 * member of the list, even though both resolve fine. A membership check
 * would reject a zone the server can perfectly well handle. */
export function isSupportedTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
