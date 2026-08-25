import { NextResponse } from "next/server";
import { eq, and, isNull } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import {
  events,
  eventAttendees,
  calendarConnections,
  eventOccurrences,
  sessionConflicts,
} from "@/db/schema";
import { getActiveConnections, groupConnectionsByMember, pickInviteConnection } from "@/db/queries";
import { requireAdminSession } from "@/lib/auth/admin";
import { participantsOutsideStatedHours, slotStillFree } from "@/lib/calendar/booking-guards";
// Nylas stays imported purely as the bridge for sessions booked before the
// switch — see resolveEventTarget. It goes when the last of them has passed.
import { cancelNylasEvent, rescheduleNylasEvent } from "@/lib/nylas";
import {
  moveSessionEvent,
  cancelSessionEvent,
  resolveOccurrenceEventId,
  type EventConnection,
} from "@/lib/calendar/events";
import { computeIdempotencyKey } from "@/lib/idempotency";
import { oneToOnePartner, syncMemberToHubspot } from "@/lib/one-to-one";
import { TIMEZONES } from "@/lib/time";

const TIMEZONE_VALUES = TIMEZONES.map((tz) => tz.value) as [string, ...string[]];

const rescheduleSchema = z.object({
  startsAtUnix: z.number().int().positive({ error: "Pick a valid time slot." }),
  durationMinutes: z.union([z.literal(15), z.literal(30), z.literal(45), z.literal(60)], {
    error: "Duration must be 15, 30, 45, or 60 minutes.",
  }),
  timezone: z.enum(TIMEZONE_VALUES, { error: "Unsupported timezone." }),
  /** Move ONE date of a repeating session, identified by where the rule puts
   * it. Absent means the whole series moves, which is what every caller did
   * before this existed and is still the default.
   *
   * The original start, never the current one: an occurrence that has already
   * been moved is keyed by where it started life, both here and at the
   * provider. */
  occurrenceStartUnix: z.number().int().positive().optional(),
});

/** drizzle-orm wraps driver errors in `DrizzleQueryError`, which has no `code`
 * of its own — the real Postgres error is on `.cause`. Same helper as
 * api/admin/events. */
function isUniqueViolation(err: unknown): boolean {
  let e = err as { code?: unknown; cause?: unknown } | undefined;
  for (let depth = 0; e && depth < 10; depth++) {
    if (e.code === "23505") return true;
    e = e.cause as typeof e;
  }
  return false;
}

/** The grant this event actually lives on. Nylas resolves an event id within a
 * grant, so cancelling or moving it MUST use the one it was created on — and
 * now that a member can hold several calendars, re-deriving "the organizer's
 * connection" would silently target the wrong one the moment they change which
 * calendar receives invites.
 *
 * `events.organizer_grant_id` is recorded at creation and is the answer.
 * Rows created before that column existed fall back to the lookup, which is
 * exactly the old behaviour and correct for anyone with a single calendar.
 * Returns null when nothing usable is connected — the caller must say so
 * rather than guessing, since we genuinely cannot reach the calendar. */
async function resolveOrganizerGrantId(event: {
  organizerGrantId: string | null;
  organizerMemberId: number;
}) {
  if (event.organizerGrantId) return event.organizerGrantId;
  const rows = await getActiveConnections([event.organizerMemberId]);
  const fallback = pickInviteConnection(
    groupConnectionsByMember(rows).get(event.organizerMemberId) ?? []
  );
  return fallback?.nylas_grant_id ?? null;
}

type EventTarget =
  | { kind: "direct"; connection: EventConnection; eventId: string }
  | { kind: "nylas"; grantId: string; eventId: string };

/** How to reach this event at the provider.
 *
 * The bridge across the switch away from Nylas. Sessions booked before it still
 * carry a Nylas event id and can only be moved or cancelled through Nylas;
 * sessions booked after carry a provider event id and the connection they were
 * created on. Both stay fully manageable, so nothing booked during the
 * changeover is stranded in people's calendars with no way to call it off.
 *
 * Direct is checked first: an event could in principle carry both, and the
 * newer path is the one we want. Returns null when neither can be reached, so
 * callers refuse rather than reporting a cancellation that didn't happen. */
async function resolveEventTarget(event: {
  providerEventId: string | null;
  organizerConnectionId: number | null;
  nylasEventId: string | null;
  organizerGrantId: string | null;
  organizerMemberId: number;
}): Promise<EventTarget | null> {
  if (event.providerEventId && event.organizerConnectionId) {
    const [connection] = await db
      .select()
      .from(calendarConnections)
      .where(eq(calendarConnections.id, event.organizerConnectionId))
      .limit(1);
    if (connection?.refreshTokenEncrypted) {
      return { kind: "direct", connection, eventId: event.providerEventId };
    }
  }
  if (event.nylasEventId) {
    const grantId = await resolveOrganizerGrantId(event);
    if (grantId) return { kind: "nylas", grantId, eventId: event.nylasEventId };
  }
  return null;
}

/** Moves ONE date of a repeating session, leaving the rest of the series alone.
 *
 * The series row is never touched. What changes is a single exception row, and
 * the provider's own exception for that instance — which is exactly how Google
 * and Outlook model this, so the result is what everyone involved would see if
 * they had dragged the date in their own calendar.
 *
 * Provider first, database second, for the same reason as every other write
 * here: if the provider fails, nothing has moved anywhere and the failure is
 * honest. The other order would show a new time in this app while everyone's
 * calendar still held the old one. */
async function moveSingleOccurrence(params: {
  eventId: number;
  event: { organizerMemberId: number };
  connection: EventConnection;
  seriesEventId: string;
  originalStartUnix: number;
  startsAtUnix: number;
  endsAtUnix: number;
  timezone: string;
  attendees: { memberId: number; role: string }[];
}) {
  const originalStartsAt = new Date(params.originalStartUnix * 1000);

  // A date moved once already has its provider id recorded. Reusing it matters:
  // looking the instance up again would search around the ORIGINAL time, where
  // the provider no longer has anything, and a second move would fail.
  const [existing] = await db
    .select()
    .from(eventOccurrences)
    .where(
      and(
        eq(eventOccurrences.eventId, params.eventId),
        eq(eventOccurrences.originalStartsAt, originalStartsAt)
      )
    )
    .limit(1);

  let instanceId = existing?.providerInstanceId ?? null;
  if (!instanceId) {
    try {
      instanceId = await resolveOccurrenceEventId({
        connection: params.connection,
        seriesEventId: params.seriesEventId,
        originalStartUnix: params.originalStartUnix,
      });
    } catch (err) {
      console.error("[admin/events/:id] Couldn't read the series' dates", {
        eventId: params.eventId,
        originalStartUnix: params.originalStartUnix,
        err,
      });
      return NextResponse.json(
        { error: "Couldn't reach the calendar to find that date. Please try again." },
        { status: 502 }
      );
    }
  }

  if (!instanceId) {
    // Never fall back to the series id here. That would move every date while
    // the admin believed they had moved one.
    return NextResponse.json(
      {
        error:
          "That date isn't in the series any more — it may have been changed in the calendar directly. Search again to see what's there.",
      },
      { status: 409 }
    );
  }

  try {
    await moveSessionEvent({
      connection: params.connection,
      providerEventId: instanceId,
      startTime: params.startsAtUnix,
      endTime: params.endsAtUnix,
      timezone: params.timezone,
    });
  } catch (err) {
    console.error("[admin/events/:id] Occurrence move failed", {
      eventId: params.eventId,
      instanceId,
      err,
    });
    return NextResponse.json(
      { error: "Couldn't move that date with the calendar provider. Please try again." },
      { status: 502 }
    );
  }

  // Past this line the calendars already show the new time.
  try {
    await db
      .insert(eventOccurrences)
      .values({
        eventId: params.eventId,
        originalStartsAt,
        status: "moved",
        startsAt: new Date(params.startsAtUnix * 1000),
        endsAt: new Date(params.endsAtUnix * 1000),
        providerInstanceId: instanceId,
      })
      // Moving the same date twice overwrites the first move rather than
      // stacking a second row that readers would have to break a tie between.
      .onConflictDoUpdate({
        target: [eventOccurrences.eventId, eventOccurrences.originalStartsAt],
        set: {
          status: "moved",
          startsAt: new Date(params.startsAtUnix * 1000),
          endsAt: new Date(params.endsAtUnix * 1000),
          providerInstanceId: instanceId,
        },
      });

    // A clash raised against this date is answered by moving it. Left open, the
    // list would still be asking about a date that no longer exists.
    await db
      .update(sessionConflicts)
      .set({ resolvedAt: new Date() })
      .where(
        and(
          eq(sessionConflicts.eventId, params.eventId),
          eq(sessionConflicts.occurrenceStartsAt, originalStartsAt),
          isNull(sessionConflicts.resolvedAt)
        )
      );
  } catch (err) {
    // The calendars are already right; only our record of it is behind. Saying
    // "failed" would invite a retry that moves the date a second time.
    console.error("[admin/events/:id] Occurrence moved at the provider but not recorded", {
      eventId: params.eventId,
      err,
    });
    return NextResponse.json(
      {
        error:
          "The date moved in everyone's calendar, but we couldn't record it here. Don't move it again — tell an admin.",
      },
      { status: 500 }
    );
  }

  const partnerId = oneToOnePartner({
    organizerMemberId: params.event.organizerMemberId,
    attendees: params.attendees,
  });
  if (partnerId !== null) await syncMemberToHubspot(partnerId);

  return NextResponse.json({ movedOccurrence: true });
}

/** Drops ONE date of a repeating session. The series keeps running.
 *
 * Same shape as moving a single date: the provider is told first, and the
 * exception row records it. The row is what stops the date coming back — the
 * rule still generates it, so without the row it would reappear on the grid the
 * moment anyone looked. */
async function cancelSingleOccurrence(params: {
  eventId: number;
  event: { organizerMemberId: number };
  connection: EventConnection;
  seriesEventId: string;
  originalStartUnix: number;
}) {
  const originalStartsAt = new Date(params.originalStartUnix * 1000);

  const [existing] = await db
    .select()
    .from(eventOccurrences)
    .where(
      and(
        eq(eventOccurrences.eventId, params.eventId),
        eq(eventOccurrences.originalStartsAt, originalStartsAt)
      )
    )
    .limit(1);

  if (existing?.status === "cancelled") {
    // Already in the state that was asked for — same reasoning as cancelling a
    // session twice. A retry after a flaky response shouldn't read as an error.
    return NextResponse.json({ cancelledOccurrence: true, alreadyCancelled: true });
  }

  let instanceId = existing?.providerInstanceId ?? null;
  if (!instanceId) {
    try {
      instanceId = await resolveOccurrenceEventId({
        connection: params.connection,
        seriesEventId: params.seriesEventId,
        originalStartUnix: params.originalStartUnix,
      });
    } catch (err) {
      console.error("[admin/events/:id] Couldn't read the series' dates", {
        eventId: params.eventId,
        originalStartUnix: params.originalStartUnix,
        err,
      });
      return NextResponse.json(
        { error: "Couldn't reach the calendar to find that date. Please try again." },
        { status: 502 }
      );
    }
  }

  // Nothing at the provider means the date is already gone from the calendars.
  // The exception row is still written: our own rule would otherwise keep
  // generating it. Deliberately NOT falling back to the series id, which would
  // cancel every date.
  if (instanceId) {
    try {
      await cancelSessionEvent({
        connection: params.connection,
        providerEventId: instanceId,
      });
    } catch (err) {
      console.error("[admin/events/:id] Occurrence cancellation failed", {
        eventId: params.eventId,
        instanceId,
        err,
      });
      return NextResponse.json(
        { error: "Couldn't drop that date with the calendar provider. Please try again." },
        { status: 502 }
      );
    }
  }

  try {
    await db
      .insert(eventOccurrences)
      .values({
        eventId: params.eventId,
        originalStartsAt,
        status: "cancelled",
        startsAt: null,
        endsAt: null,
        providerInstanceId: instanceId,
      })
      .onConflictDoUpdate({
        target: [eventOccurrences.eventId, eventOccurrences.originalStartsAt],
        // A date that was moved and is now dropped loses its new time: it isn't
        // happening anywhere.
        set: { status: "cancelled", startsAt: null, endsAt: null },
      });

    await db
      .update(sessionConflicts)
      .set({ resolvedAt: new Date() })
      .where(
        and(
          eq(sessionConflicts.eventId, params.eventId),
          eq(sessionConflicts.occurrenceStartsAt, originalStartsAt),
          isNull(sessionConflicts.resolvedAt)
        )
      );
  } catch (err) {
    console.error("[admin/events/:id] Occurrence dropped at the provider but not recorded", {
      eventId: params.eventId,
      err,
    });
    return NextResponse.json(
      {
        error:
          "The date was removed from everyone's calendar, but we couldn't record it here. Tell an admin — it may reappear in the grid.",
      },
      { status: 500 }
    );
  }

  const attendeeRows = await db
    .select({ memberId: eventAttendees.memberId, role: eventAttendees.role })
    .from(eventAttendees)
    .where(eq(eventAttendees.eventId, params.eventId));
  const partnerId = oneToOnePartner({
    organizerMemberId: params.event.organizerMemberId,
    attendees: attendeeRows,
  });
  if (partnerId !== null) await syncMemberToHubspot(partnerId);

  return NextResponse.json({ cancelledOccurrence: true });
}

/** Moves a booked session to a new time, keeping the same event and the same
 * people.
 *
 * Not cancel-then-rebook: the provider sends attendees an update for a moved
 * event rather than a cancellation followed by a fresh invite, so it stays one
 * entry in their calendar and doesn't read as "that session is off" to anyone
 * skimming their inbox.
 *
 * Nylas first, DB second — the same ordering as DELETE, for the same reason.
 * If Nylas fails nothing has moved anywhere and it's safe to report a clean
 * failure; the other order would show the new time here while everyone's
 * calendar still held the old one, and people would turn up to the wrong
 * slot. */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireAdminSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const eventId = Number((await params).id);
  if (!Number.isInteger(eventId) || eventId <= 0) {
    return NextResponse.json({ error: "Invalid session id." }, { status: 400 });
  }

  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  const parsed = rescheduleSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid request." },
      { status: 400 }
    );
  }
  const body = parsed.data;

  let event;
  let attendees;
  try {
    [event] = await db.select().from(events).where(eq(events.id, eventId)).limit(1);
    attendees = event
      ? await db.select().from(eventAttendees).where(eq(eventAttendees.eventId, eventId))
      : [];
  } catch (err) {
    console.error("[admin/events/:id] Reschedule lookup failed", { eventId, err });
    return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 });
  }

  if (!event) {
    return NextResponse.json({ error: "That session no longer exists." }, { status: 404 });
  }
  if (event.status === "cancelled") {
    return NextResponse.json(
      { error: "That session was cancelled — book a new one instead of moving it." },
      { status: 409 }
    );
  }

  const target = await resolveEventTarget(event);
  if (!target) {
    return NextResponse.json(
      {
        error:
          "The session lead's calendar is no longer connected, so this can't be moved automatically. Change it in their calendar directly.",
      },
      { status: 409 }
    );
  }

  // Moving one date of a series leaves the series itself where it is, so the
  // series' own key still describes it correctly. Rewriting it would claim the
  // whole rhythm had moved to a time only one of its dates now occupies.
  const movingOneDate = body.occurrenceStartUnix !== undefined;
  if (movingOneDate && !event.recurrenceRule) {
    return NextResponse.json(
      { error: "That session doesn't repeat, so there's no single date to move." },
      { status: 400 }
    );
  }

  // The key encodes the people AND the time, so moving the session changes it.
  // Leaving the old one in place would let the very same session be booked
  // again at its new time without tripping the duplicate check.
  const advisorMemberId = attendees.find((a) => a.role === "advisor")?.memberId ?? null;
  const guestMemberIds = attendees
    .filter((a) => a.role === "guest" && a.memberId !== event.organizerMemberId)
    .map((a) => a.memberId);
  const newKey = movingOneDate
    ? event.idempotencyKey
    : await computeIdempotencyKey({
        guestMemberIds,
        advisorMemberId,
        startsAtUnix: body.startsAtUnix,
        durationMinutes: body.durationMinutes,
      });

  if (newKey !== event.idempotencyKey) {
    const [clash] = await db
      .select({ id: events.id, status: events.status })
      .from(events)
      .where(eq(events.idempotencyKey, newKey))
      .limit(1);
    if (clash) {
      return NextResponse.json(
        { error: "These people already have a session booked at that time." },
        { status: 409 }
      );
    }
  }

  const endsAtUnix = body.startsAtUnix + body.durationMinutes * 60;

  // Moving a session had no checks at all — not the stated hours, not the
  // calendars. Booking has had both for a while, and the gap was never a
  // decision: rescheduling simply grew up separately, so a session could be
  // dragged onto a time a founder had blocked, or onto one somebody had taken
  // since the grid was drawn, and the invite update went out regardless.
  //
  // Everyone on the session, not just the guests: an advisor's and the lead's
  // own hours count the same as anyone else's.
  const participantIds = [event.organizerMemberId, ...attendees.map((a) => a.memberId)];

  let outsideTheirHours: string[];
  try {
    outsideTheirHours = await participantsOutsideStatedHours({
      memberIds: participantIds,
      startUnix: body.startsAtUnix,
      endUnix: endsAtUnix,
    });
  } catch (err) {
    console.error("[admin/events/:id] Couldn't read stated availability", { eventId, err });
    return NextResponse.json(
      { error: "Couldn't check everyone's stated hours. Please try again." },
      { status: 500 }
    );
  }
  if (outsideTheirHours.length > 0) {
    return NextResponse.json(
      {
        error: `${outsideTheirHours.join(", ")} ${
          outsideTheirHours.length === 1 ? "has" : "have"
        } said they're not available then. Pick a time from the grid, or ask them to update their hours.`,
      },
      { status: 409 }
    );
  }

  // Fails open, exactly as it does when booking — see booking-guards.ts.
  if (
    !(await slotStillFree({
      memberIds: participantIds,
      startUnix: body.startsAtUnix,
      endUnix: endsAtUnix,
      durationMinutes: body.durationMinutes,
      timezone: event.timezone,
      context: "admin/events/:id",
    }))
  ) {
    return NextResponse.json(
      {
        error:
          "That time isn't free any more — someone's calendar changed since you searched. Search again to see what's left.",
      },
      { status: 409 }
    );
  }

  // One date of a series. Everything above — the stated hours, the calendars,
  // the clash check — has already run against the new time, because a single
  // date deserves the same guards as any other booking.
  if (movingOneDate) {
    if (target.kind !== "direct") {
      // Sessions booked before the provider switch are reachable only through
      // Nylas, which has no per-occurrence handle. Saying so beats moving the
      // entire series while the admin believes they moved one afternoon.
      return NextResponse.json(
        {
          error:
            "This session was booked with the old calendar connection, so single dates can't be moved. Move it in the calendar directly, or move the whole series.",
        },
        { status: 409 }
      );
    }
    return moveSingleOccurrence({
      eventId,
      event,
      connection: target.connection,
      seriesEventId: target.eventId,
      originalStartUnix: body.occurrenceStartUnix!,
      startsAtUnix: body.startsAtUnix,
      endsAtUnix,
      timezone: body.timezone,
      attendees,
    });
  }

  try {
    if (target.kind === "direct") {
      await moveSessionEvent({
        connection: target.connection,
        providerEventId: target.eventId,
        startTime: body.startsAtUnix,
        endTime: endsAtUnix,
        timezone: body.timezone,
      });
    } else {
      // Booked before the switch — still reachable only through Nylas.
      await rescheduleNylasEvent({
        organizerGrantId: target.grantId,
        nylasEventId: target.eventId,
        startTime: body.startsAtUnix,
        endTime: endsAtUnix,
        timezone: body.timezone,
      });
    }
  } catch (err) {
    console.error("[admin/events/:id] Reschedule failed", {
      eventId,
      via: target.kind,
      providerEventId: target.eventId,
      err,
    });
    return NextResponse.json(
      { error: "Couldn't move the event with the calendar provider. Please try again." },
      { status: 502 }
    );
  }

  // Past this line everyone's calendar already shows the new time — every
  // failure below has to say so rather than implying nothing happened.
  try {
    const [updated] = await db
      .update(events)
      .set({
        startsAt: new Date(body.startsAtUnix * 1000),
        endsAt: new Date(endsAtUnix * 1000),
        timezone: body.timezone,
        idempotencyKey: newKey,
      })
      .where(eq(events.id, eventId))
      .returning();

    // A moved 1:1 changes the date Karin's list shows, so it has to change now
    // rather than tonight. `attendees` was read at the top of this handler and
    // the people on the session did not change — only the time did.
    const partnerId = oneToOnePartner({
      organizerMemberId: event.organizerMemberId,
      attendees: attendees.map((a) => ({ memberId: a.memberId, role: a.role })),
    });
    if (partnerId !== null) await syncMemberToHubspot(partnerId);

    return NextResponse.json({ event: updated });
  } catch (err) {
    if (isUniqueViolation(err)) {
      console.error("[admin/events/:id] Moved in Nylas but the new key collided", {
        eventId,
        newKey,
        err,
      });
    } else {
      console.error("[admin/events/:id] Moved in Nylas but the DB update failed", { eventId, err });
    }
    return NextResponse.json(
      {
        error:
          "The session was moved in everyone's calendar, but we couldn't update our record. It may still show at the old time here.",
      },
      { status: 500 }
    );
  }
}

/** Cancels a booked session: removes it from every attendee's calendar and
 * sends the provider's own cancellation notice.
 *
 * Admin-only on purpose. An advisor pulling out unilaterally would leave the
 * founders finding out by email, with nobody having decided the session is
 * actually off.
 *
 * Order matters and is the mirror of event creation. Nylas first, DB second:
 * if Nylas fails, nothing has changed anywhere and it's safe to report a clean
 * failure. The other order would let the grid show "cancelled" while the event
 * still sat in everyone's calendar — and people would show up to it. */
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireAdminSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const eventId = Number((await params).id);
  if (!Number.isInteger(eventId) || eventId <= 0) {
    return NextResponse.json({ error: "Invalid session id." }, { status: 400 });
  }

  let event;
  try {
    [event] = await db.select().from(events).where(eq(events.id, eventId)).limit(1);
  } catch (err) {
    console.error("[admin/events/:id] Lookup failed", { eventId, err });
    return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 });
  }

  if (!event) {
    return NextResponse.json({ error: "That session no longer exists." }, { status: 404 });
  }

  // Already cancelled: succeed rather than error. Two admins hitting cancel on
  // the same session, or a retry after a flaky response, shouldn't produce a
  // scary message about something that is in the desired state already.
  if (event.status === "cancelled") {
    return NextResponse.json({ event, alreadyCancelled: true });
  }

  // Removing it from everyone's calendar requires whichever connection the
  // event was created on. If that's gone we genuinely cannot withdraw the
  // invites, and saying so is better than marking it cancelled here while it
  // quietly stays in everyone's calendar.
  const target = await resolveEventTarget(event);
  if (!target) {
    return NextResponse.json(
      {
        error:
          "The session lead's calendar is no longer connected, so this can't be cancelled automatically. Delete it from their calendar directly.",
      },
      { status: 409 }
    );
  }

  // Dropping ONE date of a series. A query parameter rather than a body: a
  // DELETE with a payload is handled inconsistently by enough intermediaries
  // that it isn't worth the ambiguity.
  const occurrenceParam = new URL(request.url).searchParams.get("occurrenceStartUnix");
  if (occurrenceParam !== null) {
    const originalStartUnix = Number(occurrenceParam);
    if (!Number.isInteger(originalStartUnix) || originalStartUnix <= 0) {
      return NextResponse.json({ error: "Invalid date." }, { status: 400 });
    }
    if (!event.recurrenceRule) {
      return NextResponse.json(
        { error: "That session doesn't repeat, so there's no single date to drop." },
        { status: 400 }
      );
    }
    if (target.kind !== "direct") {
      return NextResponse.json(
        {
          error:
            "This session was booked with the old calendar connection, so single dates can't be dropped. Delete it in the calendar directly, or cancel the whole series.",
        },
        { status: 409 }
      );
    }
    return cancelSingleOccurrence({
      eventId,
      event,
      connection: target.connection,
      seriesEventId: target.eventId,
      originalStartUnix,
    });
  }

  try {
    if (target.kind === "direct") {
      await cancelSessionEvent({ connection: target.connection, providerEventId: target.eventId });
    } else {
      // Booked before the switch — still reachable only through Nylas.
      await cancelNylasEvent({ organizerGrantId: target.grantId, nylasEventId: target.eventId });
    }
  } catch (err) {
    console.error("[admin/events/:id] Cancellation failed", {
      eventId,
      via: target.kind,
      providerEventId: target.eventId,
      err,
    });
    return NextResponse.json(
      { error: "Couldn't cancel the event with the calendar provider. Please try again." },
      { status: 502 }
    );
  }

  // From here the invites are already withdrawn — every failure below must say
  // so rather than implying nothing happened, same as the create path.
  try {
    const [updated] = await db
      .update(events)
      .set({
        status: "cancelled",
        // Releases the idempotency key so the same people can be booked into
        // the same slot again. That column is UNIQUE, so a cancelled row went
        // on owning its key forever: rebooking the identical session computed
        // the identical hash, the pre-flight check in api/admin/events found
        // the cancelled row, and the request returned 200 with
        // alreadyExisted — a green "no duplicate created" toast for a booking
        // that never happened, with no event and no invites. Suffixing with
        // the row id keeps the column unique and leaves the original key
        // readable for anyone tracing what was cancelled.
        idempotencyKey: `${event.idempotencyKey}|cancelled:${event.id}`,
      })
      .where(eq(events.id, eventId))
      .returning();
    // Same reasoning as booking — and cancelling matters more, because the
    // field has to be CLEARED. A date left standing for a session that no
    // longer exists is the failure this whole column was chosen to avoid.
    //
    // Read here rather than reused from above: this handler has its own scope,
    // and the rows are needed after the cancellation, not before it.
    const cancelledAttendees = await db
      .select({ memberId: eventAttendees.memberId, role: eventAttendees.role })
      .from(eventAttendees)
      .where(eq(eventAttendees.eventId, eventId));
    const partnerId = oneToOnePartner({
      organizerMemberId: event.organizerMemberId,
      attendees: cancelledAttendees,
    });
    if (partnerId !== null) await syncMemberToHubspot(partnerId);

    return NextResponse.json({ event: updated, alreadyCancelled: false });
  } catch (err) {
    console.error("[admin/events/:id] Cancelled in Nylas but the DB update failed", {
      eventId,
      nylasEventId: event.nylasEventId,
      err,
    });
    return NextResponse.json(
      {
        error:
          "The session was removed from everyone's calendar, but we couldn't update our record. It may still show as booked here.",
      },
      { status: 500 }
    );
  }
}
