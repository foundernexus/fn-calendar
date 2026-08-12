import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { events, eventAttendees } from "@/db/schema";
import {
  getActiveConnections,
  getMemberById,
  getMembersByIds,
  getConfirmedEventsForMembers,
} from "@/db/queries";
import { createNylasEvent } from "@/lib/nylas";
import { computeIdempotencyKey } from "@/lib/idempotency";
import { TIMEZONES, zonedDateTimeParts, slotWithinWeeklyCap, weekStartDateString } from "@/lib/time";
import { requireAdminSession } from "@/lib/auth/admin";

const TIMEZONE_VALUES = TIMEZONES.map((tz) => tz.value) as [string, ...string[]];

const bodySchema = z.object({
  guestMemberIds: z
    .array(z.number().int())
    .min(1, "Add at least one guest.")
    .max(49, "Add at most 49 guests.") // 49 + organizer = Nylas's 50-participant cap
    .refine((ids) => new Set(ids).size === ids.length, "Duplicate guest selected."),
  organizerMemberId: z.number().int({ error: "Pick an organizer." }),
  title: z.string().trim().min(1, "Title is required."),
  description: z.string().trim().optional(),
  meetingUrl: z.string().trim().url("Enter a valid URL.").optional().or(z.literal("")),
  startsAtUnix: z.number().int().positive({ error: "Pick a valid time slot." }),
  durationMinutes: z.union([z.literal(30), z.literal(45), z.literal(60)], {
    error: "Duration must be 30, 45, or 60 minutes.",
  }),
  timezone: z.enum(TIMEZONE_VALUES, { error: "Unsupported timezone." }),
});

/** drizzle-orm wraps every driver error in `DrizzleQueryError`, which has no
 * `code` of its own — the real Postgres error (with `code: "23505"` for a
 * unique violation) is on `.cause`. Walk the chain rather than checking the
 * top-level error directly, or this never matches. */
function isUniqueViolation(err: unknown): boolean {
  let e = err as { code?: unknown; cause?: unknown } | undefined;
  for (let depth = 0; e && depth < 10; depth++) {
    if (e.code === "23505") return true;
    e = e.cause as typeof e;
  }
  return false;
}

export async function POST(request: Request) {
  const session = await requireAdminSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid request." },
      { status: 400 }
    );
  }
  const body = parsed.data;

  // The lead can't also be their own guest — drop by ID before anything else
  // touches the guest list, so the hash, the Nylas participants, and the
  // event_attendees rows all agree on the same set.
  const guestMemberIds = body.guestMemberIds.filter((id) => id !== body.organizerMemberId);
  if (guestMemberIds.length === 0) {
    return NextResponse.json(
      { error: "The session lead can't be the only guest — add at least one other person." },
      { status: 400 }
    );
  }

  const idempotencyKey = await computeIdempotencyKey({
    guestMemberIds,
    startsAtUnix: body.startsAtUnix,
    durationMinutes: body.durationMinutes,
  });

  // No Nylas call has happened yet on this branch, so a clean JSON error is
  // safe here — nothing to warn the admin about having possibly already sent.
  let existing, activeConnections, organizerMember, guestMembers;
  try {
    // Fast-path: avoids a redundant Nylas call in the common (non-racing)
    // case. NOT the correctness guarantee — that's the unique-constraint
    // catch further down.
    [existing] = await db
      .select()
      .from(events)
      .where(eq(events.idempotencyKey, idempotencyKey))
      .limit(1);
    if (existing) {
      return NextResponse.json({ event: existing, alreadyExisted: true });
    }

    activeConnections = await getActiveConnections([body.organizerMemberId, ...guestMemberIds]);
    organizerMember = await getMemberById(body.organizerMemberId);
    guestMembers = await getMembersByIds(guestMemberIds);
  } catch (err) {
    console.error("[admin/events] Pre-flight DB lookup failed", { idempotencyKey, err });
    return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 });
  }

  const connectionByMemberId = new Map(activeConnections.map((c) => [c.member_id, c]));
  const organizerConnection = connectionByMemberId.get(body.organizerMemberId);
  // The availability check ran against each connected calendar's grant_email
  // (see availability/route.ts) — a member's registered address can differ
  // from the one they actually connected, so inviting the registered address
  // would send the invite to a calendar that was never checked as free.
  // Fall back to the registered email only if they're not connected at
  // create-event time (a guest who disconnected between search and booking
  // — still invited, per the existing "unconnected doesn't block" decision).
  function resolvedEmail(memberId: number, registeredEmail: string) {
    return connectionByMemberId.get(memberId)?.grant_email ?? registeredEmail;
  }

  if (!organizerConnection || !organizerMember) {
    return NextResponse.json(
      { error: "The selected session lead isn't connected. Pick someone who's connected." },
      { status: 400 }
    );
  }

  // The UI only offers facilitators as session-lead options — same
  // client-side-filter-isn't-a-guarantee reasoning as the connection check
  // above.
  if (!organizerMember.isFacilitator) {
    return NextResponse.json(
      { error: "The selected session lead isn't a facilitator." },
      { status: 400 }
    );
  }

  const missingIds = guestMemberIds.filter((id) => !guestMembers.some((m) => m.id === id));
  if (missingIds.length > 0) {
    return NextResponse.json({ error: "One or more selected guests no longer exist." }, { status: 400 });
  }

  // Re-check each guest's weekly session cap here too, not just at search
  // time — a slot picked from a stale grid, or a race with another admin
  // booking the same guest elsewhere, could otherwise push someone over
  // their own stated limit. Never applied to the organizer — see
  // slotWithinWeeklyCap's own comment for why. ±8 days is comfortably wider
  // than any single week bucketed in any timezone around this one instant.
  const confirmedEvents = await getConfirmedEventsForMembers(
    guestMemberIds,
    new Date((body.startsAtUnix - 8 * 86_400) * 1000),
    new Date((body.startsAtUnix + 8 * 86_400) * 1000)
  );
  const guestMembersById = new Map(guestMembers.map((m) => [m.id, m]));
  const confirmedCountByGuestAndWeek = new Map<number, Map<string, number>>();
  for (const row of confirmedEvents) {
    const memberTimezone = guestMembersById.get(row.memberId)?.timezone;
    if (!memberTimezone) continue;
    const { date } = zonedDateTimeParts(Math.floor(row.startsAt.getTime() / 1000), memberTimezone);
    const weekStart = weekStartDateString(date);
    const weekMap = confirmedCountByGuestAndWeek.get(row.memberId) ?? new Map<string, number>();
    weekMap.set(weekStart, (weekMap.get(weekStart) ?? 0) + 1);
    confirmedCountByGuestAndWeek.set(row.memberId, weekMap);
  }
  const overCapNames = guestMemberIds
    .filter((id) => {
      const guest = guestMembersById.get(id);
      return !slotWithinWeeklyCap(
        { startUnix: body.startsAtUnix },
        guest?.timezone ?? null,
        guest?.weeklySessionCap ?? Infinity,
        confirmedCountByGuestAndWeek.get(id) ?? new Map()
      );
    })
    .map((id) => guestMembersById.get(id)?.fullName ?? `Member #${id}`);
  if (overCapNames.length > 0) {
    return NextResponse.json(
      {
        error: `${overCapNames.join(", ")} ${overCapNames.length === 1 ? "is" : "are"} already at their weekly session limit for this week.`,
      },
      { status: 400 }
    );
  }

  const endsAtUnix = body.startsAtUnix + body.durationMinutes * 60;

  let nylasEvent;
  try {
    const result = await createNylasEvent({
      organizerGrantId: organizerConnection.nylas_grant_id,
      title: body.title,
      description: body.description,
      meetingUrl: body.meetingUrl || undefined,
      startTime: body.startsAtUnix,
      endTime: endsAtUnix,
      timezone: body.timezone,
      // The session lead is always invited — they're leading it — in
      // addition to hosting it, not just implicitly present as the calendar
      // owner (that was the actual bug this whole redesign started from).
      participants: [
        { email: resolvedEmail(body.organizerMemberId, organizerMember.email), name: organizerMember.fullName },
        ...guestMembers.map((m) => ({ email: resolvedEmail(m.id, m.email), name: m.fullName })),
      ],
    });
    nylasEvent = result.data;
  } catch (err) {
    console.error("[admin/events] Nylas event creation failed", { idempotencyKey, err });
    return NextResponse.json(
      { error: "Couldn't create the event in Nylas. Please try again." },
      { status: 502 }
    );
  }

  // From here on, a REAL event with REAL invites already exists in Nylas —
  // every failure path below must say so, not imply nothing happened.
  let inserted;
  try {
    [inserted] = await db
      .insert(events)
      .values({
        title: body.title,
        description: body.description || null,
        startsAt: new Date(body.startsAtUnix * 1000),
        endsAt: new Date(endsAtUnix * 1000),
        timezone: body.timezone,
        meetingUrl: body.meetingUrl || null,
        organizerMemberId: body.organizerMemberId,
        nylasEventId: nylasEvent.id,
        idempotencyKey,
      })
      .returning();
  } catch (err) {
    if (isUniqueViolation(err)) {
      // A concurrent request beat us to the insert — this IS the actual
      // correctness guarantee (the pre-check above is only an optimization).
      // Our own Nylas call above is now the "losing" duplicate: it created a
      // real event that no DB row will ever reference. Logged so it's at
      // least traceable, not silently lost.
      console.error(
        "[admin/events] Lost an idempotency race — orphaned Nylas event, returning the winning row",
        { idempotencyKey, orphanedNylasEventId: nylasEvent.id }
      );
      try {
        const [winner] = await db
          .select()
          .from(events)
          .where(eq(events.idempotencyKey, idempotencyKey))
          .limit(1);
        if (winner) {
          return NextResponse.json({ event: winner, alreadyExisted: true });
        }
      } catch (selectErr) {
        console.error("[admin/events] Winner re-select also failed", {
          idempotencyKey,
          selectErr,
        });
      }
    }
    console.error("[admin/events] DB insert failed after a real Nylas event was created", {
      idempotencyKey,
      nylasEventId: nylasEvent.id,
      err,
    });
    return NextResponse.json(
      {
        error:
          "The invite may have already gone out, but we couldn't save the record. Check calendars before retrying.",
      },
      { status: 500 }
    );
  }

  try {
    await db.insert(eventAttendees).values([
      {
        eventId: inserted.id,
        memberId: body.organizerMemberId,
        attendeeEmail: resolvedEmail(body.organizerMemberId, organizerMember.email),
      },
      ...guestMembers.map((m) => ({
        eventId: inserted.id,
        memberId: m.id,
        attendeeEmail: resolvedEmail(m.id, m.email),
      })),
    ]);
  } catch (err) {
    console.error("[admin/events] event_attendees insert failed after events row was created", {
      idempotencyKey,
      eventId: inserted.id,
      nylasEventId: nylasEvent.id,
      err,
    });
    // The event itself is saved and the invites already went out — this is a
    // partial-write edge case (documented, accepted for V1), not a failure
    // to report as if nothing happened.
    return NextResponse.json({ event: inserted, alreadyExisted: false });
  }

  return NextResponse.json({ event: inserted, alreadyExisted: false });
}
