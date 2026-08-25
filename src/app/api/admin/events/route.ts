import { NextResponse } from "next/server";
import { eq, sql as raw } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { events, eventAttendees } from "@/db/schema";
import {
  getActiveConnections,
  groupConnectionsByMember,
  pickInviteConnection,
  connectionCredentials,
  getMemberById,
  getMembersByIds,
} from "@/db/queries";
import { createSessionEvent, cancelSessionEvent } from "@/lib/calendar/events";
import {
  participantsOutsideStatedHours,
  slotStillFree,
  occurrenceTimes,
  unbookableOccurrences,
} from "@/lib/calendar/booking-guards";
import { computeIdempotencyKey } from "@/lib/idempotency";
import { oneToOnePartner, syncMemberToHubspot } from "@/lib/one-to-one";
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
  durationMinutes: z.union([z.literal(15), z.literal(30), z.literal(45), z.literal(60)], {
    error: "Duration must be 15, 30, 45, or 60 minutes.",
  }),
  timezone: z.enum(TIMEZONE_VALUES, { error: "Unsupported timezone." }),
  // Fortnightly or four-weekly, rather than "monthly". A recurring 1:1 lives on
  // a fixed weekday at a fixed time; "monthly" would have to choose between
  // "the 15th" and "the first Monday", and both drift against that rhythm.
  repeatEveryWeeks: z.union([z.literal(2), z.literal(4)]).optional(),
  /** Total sessions including the one being booked, so 6 means six. */
  repeatCount: z.number().int().min(2).max(12).optional(),
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

  const connectionsByMemberId = groupConnectionsByMember(activeConnections);
  // A member can hold several calendars, all of which were checked for
  // conflicts — but the invite goes to exactly one, the one they nominated on
  // /me. Sending to all of them would land the same session in their diary
  // several times over as independent entries that cancel separately.
  const inviteConnection = (memberId: number) =>
    pickInviteConnection(connectionsByMemberId.get(memberId) ?? []);
  const organizerConnection = inviteConnection(body.organizerMemberId);
  // The availability check ran against each connected calendar's grant_email
  // (see availability/route.ts) — a member's registered address can differ
  // from the one they actually connected, so inviting the registered address
  // would send the invite to a calendar that was never checked as free.
  // Fall back to the registered email only if they're not connected at
  // create-event time (a guest who disconnected between search and booking
  // — still invited, per the existing "unconnected doesn't block" decision).
  function resolvedEmail(memberId: number, registeredEmail: string) {
    return inviteConnection(memberId)?.grant_email ?? registeredEmail;
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

  // Every calendar of everyone on this session, deduped by address — the same
  // set the search checked, and what the re-check below needs. Deduped by
  // address rather than row id so two members who share an account aren't
  // queried twice.
  const participantConnections = [
    ...new Map(
      [body.organizerMemberId, ...(advisorMember ? [advisorMember.id] : []), ...guestMemberIds]
        .flatMap((id) => connectionsByMemberId.get(id) ?? [])
        .map((c) => [c.grant_email, connectionCredentials(c)] as const)
    ).values(),
  ];

  const missingIds = guestMemberIds.filter((id) => !guestMembers.some((m) => m.id === id));
  if (missingIds.length > 0) {
    return NextResponse.json({ error: "One or more selected founders no longer exist." }, { status: 400 });
  }


  const endsAtUnix = body.startsAtUnix + body.durationMinutes * 60;

  const participantIds = [
    body.organizerMemberId,
    ...(advisorMember ? [advisorMember.id] : []),
    ...guestMemberIds,
  ];

  // Nobody gets booked outside the hours they set for themselves.
  //
  // This used to be a search-time filter only, and a comment here called stated
  // hours "the admin's to override here". They were overridable in the literal
  // sense: a start time reaching this route by any path other than clicking a
  // fresh grid cell — a tab left open, the reschedule flow, a retried request —
  // booked straight through them. Confirmed by running it, not by reading it: a
  // member whose only stated window was Mondays was booked on a Wednesday and
  // the request returned 200.
  //
  // See booking-guards.ts for why this one refuses and the next one doesn't.
  let outsideTheirHours: string[];
  try {
    outsideTheirHours = await participantsOutsideStatedHours({
      memberIds: participantIds,
      startUnix: body.startsAtUnix,
      endUnix: endsAtUnix,
    });
  } catch (err) {
    console.error("[admin/events] Couldn't read stated availability", { idempotencyKey, err });
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

  // Then: is it still clear on their actual calendars? Fails open — see
  // booking-guards.ts for why this one may not refuse and the one above must.
  if (
    !(await slotStillFree({
      memberIds: participantIds,
      startUnix: body.startsAtUnix,
      endUnix: endsAtUnix,
      durationMinutes: body.durationMinutes,
      timezone: body.timezone,
      context: "admin/events",
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

  // A repeating session is checked all the way to its last date before anything
  // is created. It is the one booking whose clashes are invisible at the moment
  // you make it: the first date is on the screen in front of you, the fourth is
  // four months out, and finding out then means an apology rather than a fix.
  //
  // Refuses outright rather than booking what fits and skipping the rest. Six
  // sessions minus two is not what anyone asked for, and a series with holes in
  // it is worse than being told to pick a different time.
  let recurrenceRule: string | undefined;
  if (body.repeatEveryWeeks && body.repeatCount) {
    const occurrences = occurrenceTimes({
      startUnix: body.startsAtUnix,
      durationMinutes: body.durationMinutes,
      intervalWeeks: body.repeatEveryWeeks,
      count: body.repeatCount,
      timezone: body.timezone,
    });
    let blocked: string[];
    try {
      blocked = await unbookableOccurrences({
        memberIds: participantIds,
        occurrences,
        durationMinutes: body.durationMinutes,
        timezone: body.timezone,
      });
    } catch (err) {
      console.error("[admin/events] Couldn't check the repeat dates", { idempotencyKey, err });
      return NextResponse.json(
        { error: "Couldn't check the later dates. Please try again." },
        { status: 500 }
      );
    }
    if (blocked.length > 0) {
      return NextResponse.json(
        {
          error: `${blocked.join(", ")} ${
            blocked.length === 1 ? "isn't" : "aren't"
          } free for everyone. Pick another time, or repeat fewer times.`,
        },
        { status: 409 }
      );
    }
    recurrenceRule = `RRULE:FREQ=WEEKLY;INTERVAL=${body.repeatEveryWeeks};COUNT=${body.repeatCount}`;
  }

  let providerEvent;
  try {
    providerEvent = await createSessionEvent({
      recurrenceRule,
      connection: connectionCredentials(organizerConnection),
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
  } catch (err) {
    // The provider's own message is carried on the error — see GoogleApiError
    // and MicrosoftApiError. Losing it here is what turned a configuration
    // fault into a morning of guessing once already.
    console.error("[admin/events] Calendar event creation failed", {
      idempotencyKey,
      organizerConnectionId: organizerConnection.id,
      error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json(
      { error: "Couldn't create the event in the calendar. Please try again." },
      { status: 502 }
    );
  }

  // From here on, a REAL event with REAL invites already exists —
  // every failure path below must say so, not imply nothing happened.
  //
  // The attendee rows go in the SAME transaction as the event, via db.batch().
  // They used to be a second, separate insert, and when it failed the request
  // still returned 200 "created" for a session with no attendees: invisible on
  // every advisor's dashboard, no obstacle to removing the people on it, and
  // unreschedulable, since the idempotency key is rebuilt from the attendee
  // list. The event id isn't known until the first statement runs, so the
  // second finds it by the idempotency key — unique, and the value we just
  // wrote.
  const attendeeValues = [
    {
      memberId: body.organizerMemberId,
      email: resolvedEmail(body.organizerMemberId, organizerMember.email),
      role: "guest",
    },
    // role: "advisor" is what lets /advisor say "you were the advisor on this
    // one" rather than listing it identically to sessions they merely
    // attended.
    ...(advisorMember
      ? [
          {
            memberId: advisorMember.id,
            email: resolvedEmail(advisorMember.id, advisorMember.email),
            role: "advisor",
          },
        ]
      : []),
    ...guestMembers.map((m) => ({
      memberId: m.id,
      email: resolvedEmail(m.id, m.email),
      role: "guest",
    })),
  ];

  let inserted;
  try {
    const [eventRows] = await db.batch([
      db
      .insert(events)
      .values({
        title: body.title,
        description: body.description || null,
        startsAt: new Date(body.startsAtUnix * 1000),
        endsAt: new Date(endsAtUnix * 1000),
        timezone: body.timezone,
        meetingUrl: body.meetingUrl || null,
        organizerMemberId: body.organizerMemberId,
        providerEventId: providerEvent.eventId,
        // Recorded, not re-derived later: an event id only means anything
        // against the calendar it was created on, and the organiser may hold
        // several calendars or change which one receives invites. Cancelling or
        // moving has to go back to this exact connection, or it 404s at the
        // provider while the meeting sits in everyone's diary.
        organizerConnectionId: organizerConnection.id,
        // Recorded so the app can say "this cancels all six" before it does.
        // Nothing else reads it — the later occurrences are real events in real
        // calendars, so free/busy greys them out without anyone expanding a
        // series here.
        recurrenceRule: recurrenceRule ?? null,
        idempotencyKey,
      })
        .returning(),
      db.execute(raw`
        INSERT INTO ${eventAttendees} (event_id, member_id, attendee_email, role)
        SELECT e.id, v.member_id, v.attendee_email, v.role::attendee_role
        FROM ${events} e
        CROSS JOIN (VALUES ${raw.join(
          attendeeValues.map((a) => raw`(${a.memberId}::int, ${a.email}::text, ${a.role}::text)`),
          raw`, `
        )}) AS v(member_id, attendee_email, role)
        WHERE e.idempotency_key = ${idempotencyKey}
      `),
    ]);
    inserted = eventRows[0];
  } catch (err) {
    // Whatever went wrong below, a real event with real invitations is already
    // sitting in everyone's calendar, and no DB row will reference it — so the
    // app can neither show it, move it, nor cancel it. Take it back.
    //
    // Best-effort and never allowed to mask the original failure: if this also
    // fails, the provider event id goes in the log so it can be removed by
    // hand. Previously the orphan was only logged, which meant a failed booking
    // still put a meeting in six people's diaries that nobody could cancel from
    // inside the tool.
    let orphanRemoved = false;
    try {
      await cancelSessionEvent({
        connection: connectionCredentials(organizerConnection),
        providerEventId: providerEvent.eventId,
      });
      orphanRemoved = true;
    } catch (cancelErr) {
      console.error("[admin/events] Couldn't remove the orphaned calendar event — remove it by hand", {
        idempotencyKey,
        providerEventId: providerEvent.eventId,
        organizerConnectionId: organizerConnection.id,
        cancelErr,
      });
    }

    if (isUniqueViolation(err)) {
      // A concurrent request beat us to the insert — this IS the actual
      // correctness guarantee (the pre-check above is only an optimization).
      // Our own calendar call above is now the "losing" duplicate: it created a
      // real event that no DB row will ever reference. The cleanup above has
      // already tried to take it back, so the winning row is the only session
      // left standing — which is the whole point of the idempotency key.
      console.warn(
        "[admin/events] Lost an idempotency race — returning the winning row",
        {
          idempotencyKey,
          duplicateProviderEventId: providerEvent.eventId,
          duplicateRemoved: orphanRemoved,
        }
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
    console.error("[admin/events] DB insert failed after a real calendar event was created", {
      idempotencyKey,
      providerEventId: providerEvent.eventId,
      orphanRemoved,
      err,
    });
    return NextResponse.json(
      {
        // Says which of the two actually happened, because the follow-up
        // differs: a withdrawn invite means retry, a stuck one means check the
        // calendar first or people get the same session twice.
        error: orphanRemoved
          ? "We couldn't save the session, so the calendar invite was withdrawn. Nothing was booked — please try again."
          : "The invite went out but we couldn't save the record, and we couldn't withdraw it either. Check the calendar before retrying, or you'll book it twice.",
      },
      { status: 500 }
    );
  }

  // Karin's HubSpot list should be right by the time she looks at it, not
  // tomorrow morning. Only for a real 1:1 — a group session changes nothing
  // about anybody's monthly check-in, and syncing twenty guests on the booking
  // path would make booking slow for no gain.
  const partnerId = oneToOnePartner({
    organizerMemberId: body.organizerMemberId,
    attendees: attendeeValues.map((a) => ({ memberId: a.memberId, role: a.role })),
  });
  if (partnerId !== null) await syncMemberToHubspot(partnerId);

  return NextResponse.json({ event: inserted, alreadyExisted: false });
}
