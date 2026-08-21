import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { events, eventAttendees, calendarConnections } from "@/db/schema";
import { getActiveConnections, groupConnectionsByMember, pickInviteConnection } from "@/db/queries";
import { requireAdminSession } from "@/lib/auth/admin";
import { participantsOutsideStatedHours, slotStillFree } from "@/lib/calendar/booking-guards";
// Nylas stays imported purely as the bridge for sessions booked before the
// switch — see resolveEventTarget. It goes when the last of them has passed.
import { cancelNylasEvent, rescheduleNylasEvent } from "@/lib/nylas";
import {
  moveSessionEvent,
  cancelSessionEvent,
  type EventConnection,
} from "@/lib/calendar/events";
import { computeIdempotencyKey } from "@/lib/idempotency";
import { TIMEZONES } from "@/lib/time";

const TIMEZONE_VALUES = TIMEZONES.map((tz) => tz.value) as [string, ...string[]];

const rescheduleSchema = z.object({
  startsAtUnix: z.number().int().positive({ error: "Pick a valid time slot." }),
  durationMinutes: z.union([z.literal(30), z.literal(45), z.literal(60)], {
    error: "Duration must be 30, 45, or 60 minutes.",
  }),
  timezone: z.enum(TIMEZONE_VALUES, { error: "Unsupported timezone." }),
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

  // The key encodes the people AND the time, so moving the session changes it.
  // Leaving the old one in place would let the very same session be booked
  // again at its new time without tripping the duplicate check.
  const advisorMemberId = attendees.find((a) => a.role === "advisor")?.memberId ?? null;
  const guestMemberIds = attendees
    .filter((a) => a.role === "guest" && a.memberId !== event.organizerMemberId)
    .map((a) => a.memberId);
  const newKey = await computeIdempotencyKey({
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
export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
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
