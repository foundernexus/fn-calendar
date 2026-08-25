import { and, eq, gte, isNull, inArray } from "drizzle-orm";
import { db } from "@/db";
import { events, eventAttendees, sessionConflicts } from "@/db/schema";
import { parseRecurrence, occurrencesBetween } from "@/lib/calendar/recurrence";
import { getExceptions, applyExceptions } from "@/lib/occurrences";
import { participantsOutsideStatedHours, occurrenceClashes } from "@/lib/calendar/booking-guards";

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

  // Dates somebody has already moved or dropped. Without these the check would
  // ask about the empty slot a session used to sit in, and stay silent about
  // the one it moved to.
  const exceptionsByEvent = await getExceptions(repeating.map((e) => e.id));

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

    const occurrences = applyExceptions(
      occurrencesBetween({
        seriesStartUnix: Math.floor(event.startsAt.getTime() / 1000),
        durationMinutes,
        recurrence,
        timezone: event.timezone,
        // Widened, then filtered below: a date moved INTO this window was
        // generated outside it, and it is the one most worth checking.
        fromUnix: fromUnix - 14 * 86_400,
        toUnix: toUnix + 14 * 86_400,
      }),
      exceptionsByEvent.get(event.id)
    ).filter((o) => o.startUnix >= fromUnix && o.startUnix <= toUnix);
    checked.series += 1;
    checked.occurrences += occurrences.length;

    for (const occurrence of occurrences) {
      // The first date of a series is the one that was booked, and booking
      // already checked it. Re-reporting it would put a conflict on the row
      // that is working.
      if (occurrence.originalStartUnix === Math.floor(event.startsAt.getTime() / 1000)) continue;

      // occurrenceClashes, NOT slotStillFree. This session is already in
      // everyone's calendar at this exact time, so "is the slot free" answers
      // no for every date of every series — see the note on that function.
      const [outsideHours, clashes] = await Promise.all([
        participantsOutsideStatedHours({
          memberIds,
          startUnix: occurrence.startUnix,
          endUnix: occurrence.endUnix,
        }),
        occurrenceClashes({
          memberIds,
          startUnix: occurrence.startUnix,
          endUnix: occurrence.endUnix,
          context: "conflicts",
        }),
      ]);

      const clear = outsideHours.length === 0 && clashes.length === 0;
      // Keyed by where the RULE puts the date, not where it currently sits.
      // Moving a date must resolve the question already raised about it rather
      // than leaving the old one open and asking a second one.
      const occurrenceAt = new Date(occurrence.originalStartUnix * 1000);

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

      // Both checks fail open — an unreadable calendar reports nothing — so
      // reaching here means somebody's stated hours ruled the date out, or a
      // calendar genuinely showed something over it. Never a network hiccup.
      //
      // Named people rather than "someone on this session is now busy": the
      // question Karin actually has is who to talk to.
      const names = outsideHours.length > 0 ? outsideHours.join(", ") : clashes.join(", ");

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
