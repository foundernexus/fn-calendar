import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { events, eventAttendees } from "@/db/schema";
import { getActiveConnections, getMemberById } from "@/db/queries";
import { createNylasEvent } from "@/lib/nylas";
import { computeIdempotencyKey } from "@/lib/idempotency";
import { TIMEZONES } from "@/lib/time";
import { normalizeEmail } from "@/lib/email";
import { requireAdminSession } from "@/lib/auth/admin";

const TIMEZONE_VALUES = TIMEZONES.map((tz) => tz.value) as [string, ...string[]];

const bodySchema = z.object({
  guestEmails: z
    .array(z.string().trim().toLowerCase().email("Enter a valid email."))
    .min(1, "Add at least one guest email.")
    .max(49, "Add at most 49 guests.") // 49 + organizer = Nylas's 50-participant cap
    .refine((emails) => new Set(emails).size === emails.length, "Duplicate guest email."),
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

  // No Nylas call has happened yet on this branch, so a clean JSON error is
  // safe here — nothing to warn the admin about having possibly already sent.
  let organizerConnection, organizerMember;
  try {
    [organizerConnection] = await getActiveConnections([body.organizerMemberId]);
    organizerMember = await getMemberById(body.organizerMemberId);
  } catch (err) {
    console.error("[admin/events] Pre-flight DB lookup failed", { err });
    return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 });
  }

  if (!organizerConnection || !organizerMember) {
    return NextResponse.json(
      { error: "The selected session lead isn't connected. Pick someone who's connected." },
      { status: 400 }
    );
  }

  const endsAtUnix = body.startsAtUnix + body.durationMinutes * 60;

  // The session lead is always invited — they're leading it — in addition to
  // hosting it. Guests are free-typed emails with no member row (an outside
  // expert, or a member who's never connected); drop any guest email that
  // matches the organizer's own — either their registered address or the
  // (possibly different) calendar account they actually connected — so
  // they're not double-invited or listed as an attendee of their own event.
  const organizerEmails = new Set([
    normalizeEmail(organizerMember.email),
    normalizeEmail(organizerConnection.grant_email),
  ]);
  const guestEmails = body.guestEmails.filter((email) => !organizerEmails.has(email));

  // zod's .min(1) on the raw list doesn't catch this: if the only typed
  // address WAS the organizer's own, filtering leaves nothing. Reject rather
  // than silently creating a solo event — an empty guest list would also
  // hash identically for every such solo event (the organizer is
  // deliberately excluded from the hash below), colliding unrelated events.
  if (guestEmails.length === 0) {
    return NextResponse.json(
      { error: "That's the session lead's own address — add at least one other guest." },
      { status: 400 }
    );
  }

  // Hashed AFTER the organizer-collision filter — the hash must reflect the
  // actual participant set Nylas receives, or two requests that produce the
  // identical real invite (one where the admin also typed the lead's own
  // address, one where they didn't) get different keys and duplicate
  // protection silently fails to catch them.
  const idempotencyKey = await computeIdempotencyKey({
    guestEmails,
    startsAtUnix: body.startsAtUnix,
    durationMinutes: body.durationMinutes,
  });

  let existing;
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
  } catch (err) {
    console.error("[admin/events] Idempotency lookup failed", { idempotencyKey, err });
    return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 });
  }

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
      participants: [
        { email: organizerMember.email, name: organizerMember.fullName },
        ...guestEmails.map((email) => ({ email })),
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
      { eventId: inserted.id, memberId: body.organizerMemberId, attendeeEmail: organizerMember.email },
      ...guestEmails.map((email) => ({ eventId: inserted.id, memberId: null, attendeeEmail: email })),
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
