import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { events, eventAttendees } from "@/db/schema";
import {
  getActiveConnections,
  getMemberById,
  getMembersByIds,
} from "@/db/queries";
import { createNylasEvent } from "@/lib/nylas";
import { computeIdempotencyKey } from "@/lib/idempotency";
import { TIMEZONES } from "@/lib/time";
import { requireAdminSession } from "@/lib/auth/admin";

const TIMEZONE_VALUES = TIMEZONES.map((tz) => tz.value) as [string, ...string[]];

const bodySchema = z.object({
  guestMemberIds: z
    .array(z.number().int())
    .min(1, "Add at least one founder.")
    .max(49, "Add at most 49 founders.") // 49 + organizer = Nylas's 50-participant cap
    .refine((ids) => new Set(ids).size === ids.length, "Duplicate founder selected."),
  organizerMemberId: z.number().int({ error: "Pick an organizer." }),
  advisorMemberId: z.number().int().nullish(),
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
      { error: "The session lead can't be the only person — add at least one founder." },
      { status: 400 }
    );
  }

  // event_attendees is unique on (event_id, member_id), so the same person
  // can't be both the advisor and a guest — the insert would blow up after
  // the invites had already gone out. Reject it up front with a message that
  // names the problem instead.
  if (body.advisorMemberId && guestMemberIds.includes(body.advisorMemberId)) {
    return NextResponse.json(
      { error: "The advisor is also selected as a founder. Remove them from the founder list." },
      { status: 400 }
    );
  }
  if (body.advisorMemberId && body.advisorMemberId === body.organizerMemberId) {
    return NextResponse.json(
      { error: "The session lead can't also be the advisor." },
      { status: 400 }
    );
  }

  const idempotencyKey = await computeIdempotencyKey({
    guestMemberIds,
    advisorMemberId: body.advisorMemberId,
    startsAtUnix: body.startsAtUnix,
    durationMinutes: body.durationMinutes,
  });

  // No Nylas call has happened yet on this branch, so a clean JSON error is
  // safe here — nothing to warn the admin about having possibly already sent.
  let existing, activeConnections, organizerMember, guestMembers, advisorMember;
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

    activeConnections = await getActiveConnections([
      body.organizerMemberId,
      ...(body.advisorMemberId ? [body.advisorMemberId] : []),
      ...guestMemberIds,
    ]);
    organizerMember = await getMemberById(body.organizerMemberId);
    guestMembers = await getMembersByIds(guestMemberIds);
    advisorMember = body.advisorMemberId ? await getMemberById(body.advisorMemberId) : null;
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

  // Mirrors the isFacilitator check above — the picker only offers advisors,
  // but that's a client-side filter, not a guarantee.
  if (body.advisorMemberId && !advisorMember?.isAdvisor) {
    return NextResponse.json(
      { error: "The selected advisor isn't marked as an advisor." },
      { status: 400 }
    );
  }

  const missingIds = guestMemberIds.filter((id) => !guestMembers.some((m) => m.id === id));
  if (missingIds.length > 0) {
    return NextResponse.json({ error: "One or more selected founders no longer exist." }, { status: 400 });
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
        // The advisor gets a real invite like everyone else — their calendar
        // was checked as free for this slot, so it has to be blocked too.
        ...(advisorMember
          ? [
              {
                email: resolvedEmail(advisorMember.id, advisorMember.email),
                name: advisorMember.fullName,
              },
            ]
          : []),
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
      // role: "advisor" is what lets /advisor say "you were the advisor on
      // this one" rather than listing it identically to sessions they merely
      // attended. Everyone else defaults to "guest".
      ...(advisorMember
        ? [
            {
              eventId: inserted.id,
              memberId: advisorMember.id,
              attendeeEmail: resolvedEmail(advisorMember.id, advisorMember.email),
              role: "advisor" as const,
            },
          ]
        : []),
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
