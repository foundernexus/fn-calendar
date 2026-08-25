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
    // Exactly one other person and no advisor — see oneToOnePartner, which the
    // immediate write shares so the two can never disagree about what counts.
    const memberId = oneToOnePartner({
      organizerMemberId: event.organizerMemberId,
      attendees: byEvent.get(event.id) ?? [],
    });
    if (memberId === null) continue;

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
  const { syncOneToOne, hubspotConfigured, findContact, updateContact } = await import(
    "@/lib/hubspot"
  );
  const summary = { members: 0, written: 0, cleared: 0, noContact: 0, failed: 0, skipped: 0 };
  if (!hubspotConfigured()) {
    summary.skipped = 1;
    return summary;
  }

  const states = await oneToOneStates(now);
  summary.members = states.length;

  for (const state of states) {
    const result = await syncOneToOne({
      // Both addresses, because they routinely differ — see findContact.
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

  // Then everybody who holds NO 1:1 any more.
  //
  // The loop above only visits members who currently have one, so on its own it
  // can add a date and move a date but can never take one away. A session
  // cancelled straight in Google — which is how most of them get cancelled —
  // would leave its date standing in HubSpot indefinitely, which is precisely
  // the stale-column problem this field was introduced to solve.
  const held = new Set(states.map((s) => s.memberId));
  const everyone = await db.select({ id: members.id, email: members.email }).from(members);
  const stale = everyone.filter((m) => !held.has(m.id));
  const staleConnections = await getLatestConnections(stale.map((m) => m.id));

  for (const member of stale) {
    try {
      const usable = staleConnections.filter(
        (c) => c.member_id === member.id && isConnectionUsable(c)
      );
      const contact = await findContact([
        member.email,
        pickInviteConnection(usable)?.grant_email ?? null,
      ]);
      // No contact is the ordinary case here rather than a problem worth
      // counting: most of the roster has never had a 1:1 booked through this
      // tool at all.
      if (!contact) continue;

      // Only write when there is something to remove. Fifty PATCHes a night
      // clearing fields that are already empty is noise in HubSpot's own
      // history, and it makes the property's change log useless for seeing what
      // actually moved.
      const alreadyClear =
        !contact.properties.fn_next_monthly_11 &&
        !contact.properties.fn_last_monthly_11 &&
        !contact.properties.fn_11_booked_through;
      if (alreadyClear) continue;

      await updateContact(contact.id, {
        fn_next_monthly_11: null,
        fn_last_monthly_11: null,
        fn_11_booked_through: null,
      });
      summary.cleared += 1;
    } catch (err) {
      // Caught per member, so one bad contact cannot cost the rest of the
      // roster its reconcile.
      console.warn(`[hubspot] clearing member ${member.id} failed:`, err);
      summary.failed += 1;
    }
  }

  return summary;
}

/** The member this session is a 1:1 with, or null if it isn't one.
 *
 * Same rule as the nightly walk, in one place so the immediate write and the
 * reconcile can never disagree about what a 1:1 is. */
export function oneToOnePartner(params: {
  organizerMemberId: number;
  attendees: { memberId: number; role: string }[];
}): number | null {
  if (params.attendees.some((a) => a.role === "advisor")) return null;
  const others = params.attendees.filter((a) => a.memberId !== params.organizerMemberId);
  return others.length === 1 ? others[0].memberId : null;
}

/** Pushes one member's 1:1 state to HubSpot, straight after a booking changes.
 *
 * The nightly run is a safety net, not the mechanism: Karin books at ten and
 * looks at her list at five past, and a date that appears tomorrow is no use to
 * her today.
 *
 * Awaited rather than fired and forgotten. It costs a booking a few hundred
 * milliseconds, and the alternative in a serverless runtime is a request that
 * gets killed the moment the response is sent — a write that usually doesn't
 * happen is worse than a slightly slower booking.
 *
 * Cannot throw. The session is already real; a note about it failing to land is
 * not a reason to tell anyone their booking failed. */
export async function syncMemberToHubspot(memberId: number, now = new Date()) {
  try {
    const { syncOneToOne, hubspotConfigured } = await import("@/lib/hubspot");
    if (!hubspotConfigured()) {
      // Said out loud. A silent skip is indistinguishable from a silent success,
      // and that ambiguity already cost an afternoon of guessing why a field
      // wouldn't clear.
      console.info(`[hubspot] no token configured, skipping member ${memberId}`);
      return;
    }

    const states = await oneToOneStates(now);
    const state = states.find((s) => s.memberId === memberId);

    if (state) {
      const result = await syncOneToOne({
        emails: [state.email, state.calendarEmail],
        fields: {
          fn_next_monthly_11: state.next,
          fn_last_monthly_11: state.last,
          fn_11_booked_through: state.bookedThrough,
          fn_calendar_email: state.calendarEmail,
        },
        context: `member ${memberId}`,
      });
      console.info(`[hubspot] member ${memberId} next=${state.next ?? "none"}: ${result}`);
      return;
    }

    // No state at all means they hold no 1:1 anywhere any more — the one they
    // had was just cancelled. Clearing is the entire point: a date left
    // standing for a meeting that no longer exists is exactly the failure that
    // made HubSpot's own field unusable here.
    const { getMemberById, getLatestConnections, isConnectionUsable, pickInviteConnection } =
      await import("@/db/queries");
    const member = await getMemberById(memberId);
    if (!member) return;

    // BOTH addresses, exactly as the write above does.
    //
    // This asymmetry was a real bug: booking searched the registered address AND
    // the connected one, cancelling searched only the registered one. Where the
    // two differ — which is common, and is the whole reason findContact takes
    // a list — the clear landed on a different contact than the write, so the
    // date sat there afterwards looking like the sync had failed.
    const usable = (await getLatestConnections([memberId])).filter(isConnectionUsable);
    const calendarEmail = pickInviteConnection(usable)?.grant_email ?? null;

    const result = await syncOneToOne({
      emails: [member.email, calendarEmail],
      fields: {
        fn_next_monthly_11: null,
        fn_last_monthly_11: null,
        fn_11_booked_through: null,
      },
      context: `member ${memberId} (cleared)`,
    });
    console.info(`[hubspot] member ${memberId} cleared: ${result}`);
  } catch (err) {
    console.warn(`[hubspot] immediate sync for member ${memberId} failed:`, err);
  }
}
