import { inArray } from "drizzle-orm";
import { db } from "@/db";
import { eventOccurrences } from "@/db/schema";

/** Where a repeating session's dates actually fall.
 *
 * The rule says every date is identical. Exceptions say otherwise, and there is
 * exactly one right way to combine them — so it lives here rather than in each
 * of the three places that needs it. The grid, the daily conflict check and the
 * 1:1 dates pushed to HubSpot all read from this, and if they disagreed the
 * symptom would be a member told about a meeting at a time nobody will be at. */

export type Exception = {
  /** Where the RULE puts the date. The stable key — see the schema. */
  originalStartUnix: number;
  status: "moved" | "cancelled";
  /** Null when cancelled. */
  startUnix: number | null;
  endUnix: number | null;
};

/** An actual date of a session, after exceptions. */
export type Occurrence = {
  startUnix: number;
  endUnix: number;
  /** What the rule called it, which is what has to be sent back to move or drop
   * it again later. Equal to `startUnix` for a date nobody has touched. */
  originalStartUnix: number;
  /** True when this date has been moved away from where the rule puts it. */
  moved: boolean;
};

export async function getExceptions(eventIds: number[]): Promise<Map<number, Exception[]>> {
  const byEvent = new Map<number, Exception[]>();
  if (eventIds.length === 0) return byEvent;

  const rows = await db
    .select()
    .from(eventOccurrences)
    .where(inArray(eventOccurrences.eventId, eventIds));

  for (const row of rows) {
    const entry: Exception = {
      originalStartUnix: Math.floor(row.originalStartsAt.getTime() / 1000),
      status: row.status === "cancelled" ? "cancelled" : "moved",
      startUnix: row.startsAt ? Math.floor(row.startsAt.getTime() / 1000) : null,
      endUnix: row.endsAt ? Math.floor(row.endsAt.getTime() / 1000) : null,
    };
    byEvent.set(row.eventId, [...(byEvent.get(row.eventId) ?? []), entry]);
  }
  return byEvent;
}

/** Folds exceptions into a list of rule-generated dates.
 *
 * Cancelled dates disappear. Moved dates keep their original key but report
 * their new time, which is what lets somebody move the same date twice — the
 * second move still refers to it by where the rule put it.
 *
 * A moved date is NOT filtered by the window it was generated in. Moving a
 * session from the 3rd to the 9th means it should show up on the 9th; a caller
 * that wants only its own window can filter afterwards, and the ones that
 * matter here — the grid, the conflict check — do exactly that. */
export function applyExceptions(
  ruleDates: { startUnix: number; endUnix: number }[],
  exceptions: Exception[] | undefined
): Occurrence[] {
  if (!exceptions || exceptions.length === 0) {
    return ruleDates.map((d) => ({ ...d, originalStartUnix: d.startUnix, moved: false }));
  }

  const byOriginal = new Map(exceptions.map((e) => [e.originalStartUnix, e]));
  const out: Occurrence[] = [];

  for (const date of ruleDates) {
    const exception = byOriginal.get(date.startUnix);
    if (!exception) {
      out.push({ ...date, originalStartUnix: date.startUnix, moved: false });
      continue;
    }
    if (exception.status === "cancelled") continue;
    // A "moved" row with no time is not something this app writes. Skipping it
    // is the safe reading: showing the date at its original time would put a
    // meeting on the grid at an hour somebody has already moved away from.
    if (exception.startUnix === null || exception.endUnix === null) continue;
    out.push({
      startUnix: exception.startUnix,
      endUnix: exception.endUnix,
      originalStartUnix: date.startUnix,
      moved: true,
    });
  }
  return out;
}
