import { and, eq, gt, inArray, isNotNull } from "drizzle-orm";
import { db } from "@/db";
import { events, eventAttendees, calendarConnections } from "@/db/schema";
import { getAccessToken, ConnectionUnusableError } from "@/lib/calendar/tokens";
import { fetchEventAttendance, asCalendarProvider } from "@/lib/calendar";
import { toResponseStatus } from "@/lib/calendar/attendance";
import { normalizeEmail } from "@/lib/email";

/** Reading back who has accepted, and writing it onto the attendee rows.
 *
 * `event_attendees.response_status` existed for a long time before anything
 * wrote to it, so every row read `noreply` — including the organiser's own, on
 * sessions they were hosting. The column was right; the answer simply was never
 * fetched. This is the fetch.
 *
 * Runs daily, from the same cron as the conflict check. Daily is the honest
 * cadence for a value that mostly changes in the hours after an invite goes
 * out and then not again, and it costs one request per upcoming session rather
 * than one per page view. Anything faster means provider push notifications,
 * which is a public endpoint and a renewal schedule — a different size of
 * thing, and not what "has Anil accepted yet" needs.
 *
 * Every failure in here is survivable and none of them writes. See the note on
 * `skipped` below: that is the property the whole design turns on. */

/** How far back to keep looking. Someone accepts on the morning of the call,
 * and a job that only looked forward would never record it. Cheap, because the
 * window is narrow and the events in it are few. */
const GRACE_HOURS = 24;

export type AttendanceRun = {
  /** Sessions whose attendance was read successfully. */
  checked: number;
  /** Sessions passed over without reading. Never an error to the caller — an
   * unusable connection, a session deleted in Google, a provider having a bad
   * minute. Each one leaves every stored answer exactly as it was. */
  skipped: number;
  /** Attendee rows whose answer actually changed. Zero is the normal result on
   * any day when nobody responded to anything. */
  updated: number;
};

/** A provider error meaning "there is no such event any more".
 *
 * Not a failure to handle: the organiser deleted it in their own calendar,
 * which they are entitled to do. Matches how deleteGoogleEvent already treats
 * these two codes. */
function isGone(err: unknown) {
  return (
    typeof err === "object" &&
    err !== null &&
    "status" in err &&
    ((err as { status: unknown }).status === 404 || (err as { status: unknown }).status === 410)
  );
}

export async function refreshAttendance(now = new Date()): Promise<AttendanceRun> {
  const since = new Date(now.getTime() - GRACE_HOURS * 3_600_000);

  // Both ids are required, not merely nice to have. providerEventId is what
  // identifies the event, and organizerConnectionId is the calendar it means
  // anything on — an event id without its connection is not resolvable, which
  // is why booking pins them together in the first place. Rows predating that
  // (the Nylas era) have neither and are simply not candidates.
  const candidates = await db
    .select({
      id: events.id,
      providerEventId: events.providerEventId,
      organizerConnectionId: events.organizerConnectionId,
    })
    .from(events)
    .where(
      and(
        eq(events.status, "confirmed"),
        isNotNull(events.providerEventId),
        isNotNull(events.organizerConnectionId),
        gt(events.endsAt, since)
      )
    );

  const run: AttendanceRun = { checked: 0, skipped: 0, updated: 0 };
  if (candidates.length === 0) return run;

  // Two queries for the whole batch rather than two per session. A day's worth
  // of upcoming sessions is small, but this job runs unattended and the shape
  // that degrades quietly with growth is the one to avoid writing.
  const connections = await db
    .select()
    .from(calendarConnections)
    .where(
      inArray(
        calendarConnections.id,
        candidates.map((c) => c.organizerConnectionId!)
      )
    );
  const connectionById = new Map(connections.map((c) => [c.id, c]));

  const attendeeRows = await db
    .select({
      id: eventAttendees.id,
      eventId: eventAttendees.eventId,
      attendeeEmail: eventAttendees.attendeeEmail,
      responseStatus: eventAttendees.responseStatus,
    })
    .from(eventAttendees)
    .where(
      inArray(
        eventAttendees.eventId,
        candidates.map((c) => c.id)
      )
    );
  const attendeesByEvent = new Map<number, typeof attendeeRows>();
  for (const row of attendeeRows) {
    attendeesByEvent.set(row.eventId, [...(attendeesByEvent.get(row.eventId) ?? []), row]);
  }

  for (const candidate of candidates) {
    const connection = connectionById.get(candidate.organizerConnectionId!);
    // The calendar the session was created on has been removed since. The
    // event may well still be in everyone's diary, but we have no credential
    // that can read it, and saying so is better than guessing.
    if (!connection) {
      run.skipped += 1;
      continue;
    }

    const provider = asCalendarProvider(connection.provider);
    let attendance;
    try {
      attendance = await fetchEventAttendance({
        provider,
        accessToken: await getAccessToken(connection),
        eventId: candidate.providerEventId!,
      });
    } catch (err) {
      run.skipped += 1;
      // Three different things, deliberately logged at three volumes. A
      // connection needing reconnection is a fact about a member, a deleted
      // event is routine, and anything else is a problem worth seeing.
      if (err instanceof ConnectionUnusableError) {
        console.info(
          `[attendance] event ${candidate.id}: connection ${connection.id} needs reconnecting`
        );
      } else if (isGone(err)) {
        console.info(`[attendance] event ${candidate.id} no longer exists at the provider`);
      } else {
        console.warn(`[attendance] event ${candidate.id} could not be read:`, err);
      }
      continue;
    }

    run.checked += 1;

    // Keyed on the normalised address because the two sides spell it
    // differently often enough to matter: we store whatever was typed or
    // connected, and the provider echoes back its own casing.
    const responseByEmail = new Map<string, string | undefined>();
    for (const entry of attendance) {
      responseByEmail.set(normalizeEmail(entry.email), entry.response);
    }

    for (const attendee of attendeesByEvent.get(candidate.id) ?? []) {
      const key = normalizeEmail(attendee.attendeeEmail);
      // `has`, not a truthiness check on the value: an attendee present with no
      // response reads as undefined, and that is not the same as an attendee
      // the provider never mentioned. The second one means somebody was removed
      // from the event in Google, or was invited at another address — either
      // way we have learned nothing about them and must leave their row alone.
      if (!responseByEmail.has(key)) continue;

      const status = toResponseStatus(provider, responseByEmail.get(key));
      // Null is "the provider said something this code doesn't recognise".
      // Skipping is what stops a future vocabulary change quietly resetting
      // everyone to noreply. Equality is the ordinary no-op: most rows on most
      // days already say the right thing.
      if (status === null || status === attendee.responseStatus) continue;

      await db
        .update(eventAttendees)
        .set({ responseStatus: status })
        .where(eq(eventAttendees.id, attendee.id));
      run.updated += 1;
    }
  }

  return run;
}
