import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { events, eventAttendees } from "@/db/schema";
import { getActiveConnections, getMembersByIds } from "@/db/queries";
import { createNylasEvent } from "@/lib/nylas";
import { computeIdempotencyKey } from "@/lib/idempotency";
import { TIMEZONES } from "@/lib/time";
import { requireAdminSession } from "@/lib/auth/admin";

const TIMEZONE_VALUES = TIMEZONES.map((tz) => tz.value) as [string, ...string[]];

const bodySchema = z.object({
  memberIds: z
    .array(z.number().int())
    .min(1, "Select at least one member.")
    .max(50, "Select at most 50 members.") // 50 = Nylas's participant cap
    .refine((ids) => new Set(ids).size === ids.length, "Duplicate member selected."),
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

  const idempotencyKey = await computeIdempotencyKey({
    memberIds: body.memberIds,
    startsAtUnix: body.startsAtUnix,
    durationMinutes: body.durationMinutes,
  });

  // No Nylas call has happened yet on this branch, so a clean JSON error is
  // safe here — nothing to warn the admin about having possibly already sent.
  let existing, organizerConnection, selectedMembers;
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

    [organizerConnection] = await getActiveConnections([body.organizerMemberId]);

    // Every selected member becomes an invitee, connected or not — an
    // unconnected member's free/busy couldn't be checked, but they still
    // receive a real invite (confirmed product decision). Participants are
    // members.email (not grant_email): unconnected members have no
    // grant_email at all, so this is the only address that works uniformly.
    selectedMembers = await getMembersByIds(body.memberIds);
  } catch (err) {
    console.error("[admin/events] Pre-flight DB lookup failed", { idempotencyKey, err });
    return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 });
  }

  if (!organizerConnection) {
    return NextResponse.json(
      { error: "The selected organizer isn't connected. Pick someone who's connected." },
      { status: 400 }
    );
  }

  const missingIds = body.memberIds.filter((id) => !selectedMembers.some((m) => m.id === id));
  if (missingIds.length > 0) {
    return NextResponse.json({ error: "One or more selected members no longer exist." }, { status: 400 });
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
      participants: selectedMembers.map((m) => ({ email: m.email, name: m.fullName })),
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
    await db.insert(eventAttendees).values(
      selectedMembers.map((m) => ({
        eventId: inserted.id,
        memberId: m.id,
        attendeeEmail: m.email,
      }))
    );
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
