import { and, eq, gte, isNull, inArray } from "drizzle-orm";
import { db } from "@/db";
import { events, eventAttendees, sessionConflicts } from "@/db/schema";
import { parseRecurrence, occurrencesBetween } from "@/lib/calendar/recurrence";
import { participantsOutsideStatedHours, slotStillFree } from "@/lib/calendar/booking-guards";

/** How far ahead to look.
 *
 * Far enough that a clash can still be moved without an apology, near enough
 * that it isn't chasing dates nobody has planned around yet. Eight weeks covers
 * the next two occurrences of a four-weekly 1:1, which is the shape this is
 * for. */
const LOOKAHEAD_DAYS = 56;

/** Checks the upcoming dates of every repeating session and records the ones
 * somebody has since booked over.
 *
 * The whole reason this exists as a scheduled job rather than a check at
 * booking time: a series is agreed once and then lives on its own. Somebody
 * puts a flight in front of the fourth date in November, and without something
 * looking, nobody finds out until the day.
 *
 * Reads only. It writes nothing to anybody's calendar and moves nothing — the
 * decision about what to do with a clash belongs to a person. */
export async function detectSeriesConflicts(now = new Date()) {
  const fromUnix = Math.floor(now.getTime() / 1000);
  const toUnix = fromUnix + LOOKAHEAD_DAYS * 86_400;

  const series = await db
    .select()
    .from(events)
    .where(and(eq(events.status, "confirmed"), gte(events.endsAt, now)));

  const repeating = series.filter((e) => e.recurrenceRule);
  const checked = { series: 0, occurrences: 0, raised: 0, resolved: 0 };
  if (repeating.length === 0) return checked;

  const attendeeRows = await db
    .select({ eventId: eventAttendees.eventId, memberId: eventAttendees.memberId })
    .from(eventAttendees)
    .where(
      inArray(
        eventAttendees.eventId,
        repeating.map((e) => e.id)
      )
    );
  const attendeesByEvent = new Map<number, number[]>();
  for (const row of attendeeRows) {
    attendeesByEvent.set(row.eventId, [
      ...(attendeesByEvent.get(row.eventId) ?? []),
      row.memberId,
    ]);
  }

  for (const event of repeating) {
    const recurrence = parseRecurrence(event.recurrenceRule);
    // A rule we did not write — someone rebuilt the series in Google — is not
    // something to half-understand. Left alone rather than guessed at.
    if (!recurrence) continue;

    const memberIds = [
      event.organizerMemberId,
      ...(attendeesByEvent.get(event.id) ?? []),
    ];
    const durationMinutes = Math.round(
      (event.endsAt.getTime() - event.startsAt.getTime()) / 60_000
    );

    const occurrences = occurrencesBetween({
      seriesStartUnix: Math.floor(event.startsAt.getTime() / 1000),
      durationMinutes,
      recurrence,
      timezone: event.timezone,
      fromUnix,
      toUnix,
    });
    checked.series += 1;
    checked.occurrences += occurrences.length;

    for (const occurrence of occurrences) {
      // The first date of a series is the one that was booked, and booking
      // already checked it. Re-reporting it would put a conflict on the row
      // that is working.
      if (occurrence.startUnix === Math.floor(event.startsAt.getTime() / 1000)) continue;

      const [outsideHours, free] = await Promise.all([
        participantsOutsideStatedHours({
          memberIds,
          startUnix: occurrence.startUnix,
          endUnix: occurrence.endUnix,
        }),
        slotStillFree({
          memberIds,
          startUnix: occurrence.startUnix,
          endUnix: occurrence.endUnix,
          durationMinutes,
          timezone: event.timezone,
          context: "conflicts",
        }),
      ]);

      const clear = outsideHours.length === 0 && free;
      const occurrenceAt = new Date(occurrence.startUnix * 1000);

      if (clear) {
        // Resolved rather than deleted, so tomorrow's list can say a clash
        // sorted itself out instead of the row quietly vanishing.
        const done = await db
          .update(sessionConflicts)
          .set({ resolvedAt: new Date() })
          .where(
            and(
              eq(sessionConflicts.eventId, event.id),
              eq(sessionConflicts.occurrenceStartsAt, occurrenceAt),
              isNull(sessionConflicts.resolvedAt)
            )
          )
          .returning({ id: sessionConflicts.id });
        checked.resolved += done.length;
        continue;
      }

      // `slotStillFree` fails open — it says true when it could not establish
      // otherwise — so reaching here means somebody's stated hours ruled it out
      // or a calendar genuinely reported a clash. Never a network hiccup.
      const names =
        outsideHours.length > 0
          ? outsideHours.join(", ")
          : "someone on this session is now busy";

      await db
        .insert(sessionConflicts)
        .values({ eventId: event.id, occurrenceStartsAt: occurrenceAt, conflictingNames: names })
        // Raised once per date, not once per day until somebody deals with it.
        .onConflictDoNothing();
      checked.raised += 1;
    }
  }

  return checked;
}
