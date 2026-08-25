import { eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { events, eventAttendees, members } from "@/db/schema";
import { parseRecurrence, occurrencesBetween } from "@/lib/calendar/recurrence";
import { isConnectionUsable, getLatestConnections, pickInviteConnection } from "@/db/queries";

/** A member's standing 1:1 rhythm, as this tool knows it.
 *
 * "A 1:1" is deliberately narrow: a session led by a facilitator with exactly
 * one other person on it and no advisor. The HubSpot fields are called "Monthly
 * 1:1", and putting a six-person session in them would make the column mean
 * "some meeting exists", which is precisely the vagueness that made HubSpot's
 * own Next Activity Date useless here — it counted anybody's meeting with
 * anybody.
 *
 * What this cannot know: 1:1s booked straight into Google without going through
 * the tool. Karin has been doing that for months — "I'm just booking" — so in
 * the first weeks a member may show as having nothing when they do. That errs
 * towards looking twice rather than towards somebody falling through, which is
 * the right way round for a work list. */

export type OneToOneState = {
  memberId: number;
  email: string;
  /** The address their calendar is connected under, when they have one. */
  calendarEmail: string | null;
  /** `YYYY-MM-DD` in the session's own timezone, or null. */
  next: string | null;
  last: string | null;
  /** The final date of a repeating 1:1, as an ISO timestamp — HubSpot types
   * this field as `datetime`, unlike the two above which are `date`. Sending it
   * as `YYYY-MM-DD` is rejected.
   *
   * Null for a one-off, and null for a series with no end: there is no date to
   * give, and reporting the horizon we happen to walk to would be a number
   * nobody chose. */
  bookedThrough: string | null;
};

/** Date in the SESSION's timezone, not the server's. A 1:1 at 17:00 Pacific is
 * still that day in Seattle when the server has already rolled over to the
 * next. Getting this wrong shifts every date by one for half the day. */
function localDate(unix: number, timezone: string) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(new Date(unix * 1000));
}

/** How far ahead to expand a repeating 1:1 when looking for the next one. Two
 * years is well past any cadence in use and keeps the walk bounded. */
const HORIZON_DAYS = 730;

export async function oneToOneStates(now = new Date()): Promise<OneToOneState[]> {
  const nowUnix = Math.floor(now.getTime() / 1000);

  const rows = await db
    .select({
      id: events.id,
      startsAt: events.startsAt,
      endsAt: events.endsAt,
      timezone: events.timezone,
      recurrenceRule: events.recurrenceRule,
      organizerMemberId: events.organizerMemberId,
    })
    .from(events)
    .where(eq(events.status, "confirmed"));

  if (rows.length === 0) return [];

  const attendeeRows = await db
    .select({
      eventId: eventAttendees.eventId,
      memberId: eventAttendees.memberId,
      role: eventAttendees.role,
    })
    .from(eventAttendees)
    .where(
      inArray(
        eventAttendees.eventId,
        rows.map((r) => r.id)
      )
    );
  const byEvent = new Map<number, { memberId: number; role: string }[]>();
  for (const a of attendeeRows) {
    byEvent.set(a.eventId, [...(byEvent.get(a.eventId) ?? []), a]);
  }

  const facilitatorIds = new Set(
    (await db.select({ id: members.id }).from(members).where(eq(members.isFacilitator, true))).map(
      (m) => m.id
    )
  );

  // memberId -> every occurrence of every 1:1 they are on, plus the last date
  // of each series they belong to.
  const occurrencesByMember = new Map<number, number[]>();
  const seriesEndByMember = new Map<number, number[]>();
  // Inside the function, not module scope: this runs in a long-lived process,
  // and a Map declared outside would carry one request's members into the next.
  const timezoneByMember = new Map<number, string>();

  for (const event of rows) {
    if (!facilitatorIds.has(event.organizerMemberId)) continue;
    const attendees = byEvent.get(event.id) ?? [];
    if (attendees.some((a) => a.role === "advisor")) continue;

    const others = attendees.filter((a) => a.memberId !== event.organizerMemberId);
    // Exactly one other person. Two makes it a small session, not a 1:1.
    if (others.length !== 1) continue;
    const memberId = others[0].memberId;

    const startUnix = Math.floor(event.startsAt.getTime() / 1000);
    const durationMinutes = Math.round(
      (event.endsAt.getTime() - event.startsAt.getTime()) / 60_000
    );
    const recurrence = parseRecurrence(event.recurrenceRule);

    let occurrences: number[];
    if (recurrence) {
      occurrences = occurrencesBetween({
        seriesStartUnix: startUnix,
        durationMinutes,
        recurrence,
        timezone: event.timezone,
        fromUnix: startUnix,
        toUnix: nowUnix + HORIZON_DAYS * 86_400,
      }).map((o) => o.startUnix);
      // Only a series that actually ends has a "booked through" date. An
      // endless one is not booked through anything, and inventing the horizon
      // as an answer would be a number nobody chose.
      if (recurrence.count !== null && occurrences.length > 0) {
        seriesEndByMember.set(memberId, [
          ...(seriesEndByMember.get(memberId) ?? []),
          occurrences[occurrences.length - 1],
        ]);
      }
    } else {
      occurrences = [startUnix];
    }

    occurrencesByMember.set(memberId, [
      ...(occurrencesByMember.get(memberId) ?? []),
      ...occurrences,
    ]);
    // Timezone is carried per member so dates render in the zone the session
    // was booked in.
    timezoneByMember.set(memberId, event.timezone);
  }

  if (occurrencesByMember.size === 0) return [];

  const memberIds = [...occurrencesByMember.keys()];
  const memberRows = await db
    .select({ id: members.id, email: members.email })
    .from(members)
    .where(inArray(members.id, memberIds));
  const emailById = new Map(memberRows.map((m) => [m.id, m.email]));

  const connections = await getLatestConnections(memberIds);
  const calendarEmailById = new Map<number, string>();
  for (const memberId of memberIds) {
    const usable = connections.filter((c) => c.member_id === memberId && isConnectionUsable(c));
    const invite = pickInviteConnection(usable);
    if (invite) calendarEmailById.set(memberId, invite.grant_email);
  }

  return memberIds.map((memberId) => {
    const zone = timezoneByMember.get(memberId) ?? "America/Los_Angeles";
    const all = (occurrencesByMember.get(memberId) ?? []).sort((a, b) => a - b);
    const future = all.filter((t) => t >= nowUnix);
    const past = all.filter((t) => t < nowUnix);
    const ends = (seriesEndByMember.get(memberId) ?? []).sort((a, b) => b - a);

    return {
      memberId,
      email: emailById.get(memberId) ?? "",
      calendarEmail: calendarEmailById.get(memberId) ?? null,
      next: future.length > 0 ? localDate(future[0], zone) : null,
      last: past.length > 0 ? localDate(past[past.length - 1], zone) : null,
      bookedThrough: ends.length > 0 ? new Date(ends[0] * 1000).toISOString() : null,
    };
  });
}

/** Pushes every member's 1:1 state to their HubSpot contact.
 *
 * Run nightly rather than only at booking time, and that is the point: a write
 * that failed at 3pm — HubSpot having a moment, a token just rotated — fixes
 * itself tonight instead of leaving one wrong date standing indefinitely. It is
 * also what covers a session cancelled outside the tool.
 *
 * Every failure is counted and none of them stops the run. One member with no
 * matching contact must not cost the other fifty their update. */
export async function syncOneToOneToHubspot(now = new Date()) {
  const { syncOneToOne, hubspotConfigured } = await import("@/lib/hubspot");
  const summary = { members: 0, written: 0, noContact: 0, failed: 0, skipped: 0 };
  if (!hubspotConfigured()) {
    summary.skipped = 1;
    return summary;
  }

  const states = await oneToOneStates(now);
  summary.members = states.length;

  for (const state of states) {
    const result = await syncOneToOne({
      // Both addresses, because they routinely differ — see findContactId.
      emails: [state.email, state.calendarEmail],
      fields: {
        fn_next_monthly_11: state.next,
        fn_last_monthly_11: state.last,
        fn_11_booked_through: state.bookedThrough,
        fn_calendar_email: state.calendarEmail,
      },
      context: `member ${state.memberId}`,
    });
    if (result === "written") summary.written += 1;
    else if (result === "no-contact") summary.noContact += 1;
    else if (result === "failed") summary.failed += 1;
  }

  return summary;
}
