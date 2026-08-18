import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { events } from "@/db/schema";
import { getActiveConnections } from "@/db/queries";
import { requireAdminSession } from "@/lib/auth/admin";
import { cancelNylasEvent } from "@/lib/nylas";

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

  // Deleting from the provider requires the grant the event was created on —
  // the organizer's. If they've since disconnected we genuinely cannot remove
  // it from anyone's calendar, and saying so is better than marking it
  // cancelled here while it quietly stays in everyone's calendar.
  const [organizerConnection] = await getActiveConnections([event.organizerMemberId]);
  if (!organizerConnection) {
    return NextResponse.json(
      {
        error:
          "The session lead's calendar is no longer connected, so this can't be cancelled automatically. Delete it from their calendar directly.",
      },
      { status: 409 }
    );
  }

  try {
    await cancelNylasEvent({
      organizerGrantId: organizerConnection.nylas_grant_id,
      nylasEventId: event.nylasEventId,
    });
  } catch (err) {
    console.error("[admin/events/:id] Nylas cancellation failed", {
      eventId,
      nylasEventId: event.nylasEventId,
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
