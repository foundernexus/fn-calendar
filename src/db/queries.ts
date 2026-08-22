import { eq, inArray, and, or, gte, lte, lt, gt, sql, desc } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db } from "./index";
import { calendarConnections, members, memberAvailability, events, eventAttendees } from "./schema";
import { normalizeEmail } from "@/lib/email";
import { env } from "@/lib/env";

/** Case-insensitive member lookup — always goes through normalizeEmail so a
 * mixed-case input never silently misses a stored row. */
export async function getMemberByEmail(email: string) {
  const rows = await db
    .select()
    .from(members)
    .where(eq(members.email, normalizeEmail(email)))
    .limit(1);
  return rows[0] ?? null;
}

export async function getMemberById(id: number) {
  const rows = await db.select().from(members).where(eq(members.id, id)).limit(1);
  return rows[0] ?? null;
}

/** Batch member lookup — one query instead of N. */
export async function getMembersByIds(ids: number[]) {
  if (ids.length === 0) return [];
  return db.select().from(members).where(inArray(members.id, ids));
}

/** A member's own weekly availability rows, ordered by day. No row for a
 * given day means that day is off — see the comment on `memberAvailability`
 * in schema.ts. */
export async function getMemberAvailability(memberId: number) {
  return db
    .select()
    .from(memberAvailability)
    .where(eq(memberAvailability.memberId, memberId))
    .orderBy(memberAvailability.dayOfWeek);
}

/** Same as `getMemberAvailability`, batched for the find-a-time search — one
 * query for every selected member (organizer + guests) instead of N. */
export async function getMemberAvailabilityForMembers(memberIds: number[]) {
  if (memberIds.length === 0) return [];
  return db
    .select()
    .from(memberAvailability)
    .where(inArray(memberAvailability.memberId, memberIds));
}


/** Every CONFIRMED event overlapping [from, to) that any of `memberIds` is
 * either leading or attending — used to mark already-booked cells on the
 * find-a-time grid, so an admin sees WHY a slot is unavailable (something
 * booked through this tool) instead of an unexplained gray cell. Deduped by
 * event id: a session could match via both its organizer and one of its
 * guests being in `memberIds`, or via two selected guests both being on the
 * same event — either way it's one block, not two. */
export async function getBookedEventsOverlapping(memberIds: number[], from: Date, to: Date) {
  if (memberIds.length === 0) return [];
  const rows = await db
    .select({
      id: events.id,
      title: events.title,
      startsAt: events.startsAt,
      endsAt: events.endsAt,
      // Needed to reschedule: the grid has to be able to repopulate the search
      // with exactly the people this session already has.
      organizerMemberId: events.organizerMemberId,
      // Needed to warn before cancelling: cancelling acts on the whole series,
      // and a booked cell gives no hint that the date behind it is one of six.
      recurrenceRule: events.recurrenceRule,
    })
    .from(events)
    .leftJoin(eventAttendees, eq(eventAttendees.eventId, events.id))
    .where(
      and(
        eq(events.status, "confirmed"),
        or(inArray(events.organizerMemberId, memberIds), inArray(eventAttendees.memberId, memberIds)),
        lt(events.startsAt, to),
        gt(events.endsAt, from)
      )
    );

  const byId = new Map<number, (typeof rows)[number]>();
  for (const row of rows) {
    if (!byId.has(row.id)) byId.set(row.id, row);
  }
  const found = [...byId.values()];
  if (found.length === 0) return [];

  // Attendees are fetched separately rather than read off the join above: that
  // join is filtered to the members being searched for, so it only ever sees
  // the attendees who matched — which is exactly the wrong list when the point
  // is showing an admin everyone a session would affect before they cancel it.
  const attendeeRows = await db
    .select({
      eventId: eventAttendees.eventId,
      memberId: eventAttendees.memberId,
      fullName: members.fullName,
      // The address actually invited, which can differ from the registered one
      // when someone connected a different calendar account.
      email: eventAttendees.attendeeEmail,
      role: eventAttendees.role,
    })
    .from(eventAttendees)
    .innerJoin(members, eq(eventAttendees.memberId, members.id))
    .where(
      inArray(
        eventAttendees.eventId,
        found.map((e) => e.id)
      )
    );

  const attendeesByEvent = new Map<
    number,
    { memberId: number; fullName: string; email: string; role: string }[]
  >();
  for (const a of attendeeRows) {
    const list = attendeesByEvent.get(a.eventId) ?? [];
    list.push({ memberId: a.memberId, fullName: a.fullName, email: a.email, role: a.role });
    attendeesByEvent.set(a.eventId, list);
  }

  return found.map((e) => ({ ...e, attendees: attendeesByEvent.get(e.id) ?? [] }));
}

/** No responseStatus: the column exists but nothing ever updates it (see
 * AttendeeRow in advisor-session-list.tsx), so selecting it only offered
 * callers a value that is permanently "noreply". The column itself is kept —
 * dropping it would be a migration against production for no gain, and it's
 * what a future RSVP webhook would write into. */
export type SessionAttendee = {
  memberId: number;
  fullName: string;
  email: string;
  role: "guest" | "advisor";
};

export type MemberSession = {
  id: number;
  title: string;
  description: string | null;
  startsAt: Date;
  endsAt: Date;
  timezone: string;
  meetingUrl: string | null;
  status: "confirmed" | "cancelled";
  role: "guest" | "advisor";
  organizerName: string;
  organizerEmail: string;
  attendees: SessionAttendee[];
};

/** Every session this member is an attendee of, newest first — the list behind
 * /advisor's "Your sessions". Driven off event_attendees rather than events so
 * `role` comes along: the same person can be the advisor on one session and an
 * ordinary guest on another, and the panel needs to say which.
 *
 * Deliberately includes cancelled sessions. Somebody who cleared their morning
 * for a session needs to see that it was called off, not have it silently
 * vanish from the list. */
export async function getSessionsForMember(memberId: number): Promise<MemberSession[]> {
  const organizer = alias(members, "organizer");
  const rows = await db
    .select({
      id: events.id,
      title: events.title,
      description: events.description,
      startsAt: events.startsAt,
      endsAt: events.endsAt,
      timezone: events.timezone,
      meetingUrl: events.meetingUrl,
      status: events.status,
      role: eventAttendees.role,
      organizerName: organizer.fullName,
      organizerEmail: organizer.email,
    })
    .from(eventAttendees)
    .innerJoin(events, eq(eventAttendees.eventId, events.id))
    .innerJoin(organizer, eq(events.organizerMemberId, organizer.id))
    .where(eq(eventAttendees.memberId, memberId))
    .orderBy(desc(events.startsAt));

  if (rows.length === 0) return [];

  // One query for every attendee of every session, grouped in memory, rather
  // than a per-session query. An advisor with fifty past sessions would
  // otherwise fire fifty round trips to render one page.
  const attendeeRows = await db
    .select({
      eventId: eventAttendees.eventId,
      memberId: eventAttendees.memberId,
      fullName: members.fullName,
      // The address actually invited, which can differ from the registered
      // one when someone connected a different calendar account.
      email: eventAttendees.attendeeEmail,
      role: eventAttendees.role,
    })
    .from(eventAttendees)
    .innerJoin(members, eq(eventAttendees.memberId, members.id))
    .where(
      inArray(
        eventAttendees.eventId,
        rows.map((r) => r.id)
      )
    );

  const attendeesByEvent = new Map<number, SessionAttendee[]>();
  for (const a of attendeeRows) {
    const list = attendeesByEvent.get(a.eventId) ?? [];
    list.push({
      memberId: a.memberId,
      fullName: a.fullName,
      email: a.email,
      role: a.role,
    });
    attendeesByEvent.set(a.eventId, list);
  }

  return rows.map((r) => ({
    ...r,
    // Advisors first, then alphabetical — the advisor is the one role worth
    // spotting at a glance in a long attendee list.
    attendees: (attendeesByEvent.get(r.id) ?? []).sort(
      (a, b) =>
        (a.role === "advisor" ? 0 : 1) - (b.role === "advisor" ? 0 : 1) ||
        a.fullName.localeCompare(b.fullName)
    ),
  }));
}

export type LatestConnectionRow = {
  id: number;
  member_id: number;
  nylas_grant_id: string | null;
  provider: string;
  grant_email: string;
  nylas_client_id: string | null;
  connection_status: "connected" | "revoked";
  /** Encrypted OAuth credentials, since we talk to Google and Microsoft
   * directly. Null on rows created through Nylas, which is what makes those
   * rows read as needing a reconnect. */
  refresh_token_encrypted: string | null;
  access_token_encrypted: string | null;
  /** A STRING in practice, like connected_at below — same raw-SQL reason. Go
   * through connectionCredentials rather than using it directly. */
  access_token_expires_at: string | Date | null;
  /** A STRING in practice, despite the name. These rows come from
   * `db.execute()` with raw SQL, which hands back whatever the neon HTTP
   * driver produced without drizzle's column parsing — timestamps arrive as
   * ISO strings. This was typed `Date` for a long time and nobody noticed,
   * because the value was only ever used inside SQL ORDER BY; the first code
   * to call a Date method on it crashed /me. Go through connectedAtMs. */
  connected_at: string | Date;
  revoked_at: string | Date | null;
  is_primary: boolean;
};

/** Comparable timestamp for a connection row, whichever shape the driver
 * handed back. */
export function connectedAtMs(row: LatestConnectionRow) {
  return row.connected_at instanceof Date
    ? row.connected_at.getTime()
    : new Date(row.connected_at).getTime();
}

/** A connection is only usable if it's marked connected AND we hold a refresh
 * token for it.
 *
 * That second condition is what carries the switch away from Nylas. Rows
 * created through Nylas have no refresh token and never will, so they stop
 * being usable the moment this ships — which is correct, because nothing can
 * be read from them any more. They aren't hidden: getMemberConnectionState
 * still lists them, marked "needs reconnect", so the member sees a button
 * rather than an unexplained absence.
 *
 * This replaced a check against the current Nylas client id, which existed for
 * the same reason in the Nylas world: a row can look connected and still be
 * unusable, and connection_status alone was never enough to tell. */
export function isConnectionUsable(row: LatestConnectionRow) {
  return row.connection_status === "connected" && row.refresh_token_encrypted !== null;
}

/** The credentials shape the calendar modules expect, converted out of the raw
 * SQL row.
 *
 * The date conversion is the point: these rows come from db.execute(), which
 * hands back whatever the neon HTTP driver produced, and timestamps arrive as
 * ISO strings rather than Dates. Passing one straight through would make the
 * token manager compare a string to a number and refresh on every single call
 * — or worse, never. The same trap already crashed /me once via connected_at. */
export function connectionCredentials(row: LatestConnectionRow) {
  return {
    id: row.id,
    provider: row.provider,
    grantEmail: row.grant_email,
    refreshTokenEncrypted: row.refresh_token_encrypted,
    accessTokenEncrypted: row.access_token_encrypted,
    accessTokenExpiresAt: row.access_token_expires_at
      ? row.access_token_expires_at instanceof Date
        ? row.access_token_expires_at
        : new Date(row.access_token_expires_at)
      : null,
  };
}

/**
 * The latest connection row per member (a member can reconnect and produce
 * multiple `calendar_connections` rows over time — this resolves to the most
 * recent one, connected OR revoked). Optionally scoped to a set of member IDs.
 * Callers that need to know if a member can actually be scheduled should use
 * `getActiveConnections` instead — this one intentionally includes revoked rows.
 */
export async function getLatestConnections(memberIds?: number[]) {
  // `undefined` means "no filter, every member"; `[]` means "filter to
  // nothing" — those are different requests and must not both fall through
  // to the same unfiltered query.
  if (memberIds && memberIds.length === 0) return [];

  const memberFilter =
    memberIds && memberIds.length > 0
      ? sql`WHERE member_id IN (${sql.join(
          memberIds.map((id) => sql`${id}`),
          sql`, `
        )})`
      : sql``;

  // DISTINCT ON (member_id, grant_email), not (member_id): a member may hold
  // several calendars, and all of them have to survive this query so every one
  // gets checked for conflicts. Deduping by grant_email is what still collapses
  // RECONNECTS — reconnecting the same account yields the same address, so the
  // newest row wins — while a genuinely different account is kept as its own
  // calendar. Deduping by member_id alone silently hid every calendar but the
  // most recent.
  //
  // Rows we hold a refresh token for win before recency does. One address
  // accumulates rows over time — through Nylas, then directly — and picking
  // purely by newest could surface an unusable Nylas row and report a member as
  // disconnected while a perfectly good one sat right behind it. This replaced
  // the same rule expressed against the Nylas client id, for the same reason.
  //
  // Deliberately does NOT prefer connected over revoked: for one address the
  // newest row is the truth about that calendar, and reaching past a revoked
  // row to an older connected one would resurrect a calendar the member
  // deliberately disconnected.
  const result = await db.execute<LatestConnectionRow>(sql`
    SELECT DISTINCT ON (member_id, grant_email) *
    FROM ${calendarConnections}
    ${memberFilter}
    ORDER BY
      member_id,
      grant_email,
      (refresh_token_encrypted IS NOT NULL) DESC,
      connected_at DESC,
      id DESC
  `);

  return result.rows;
}

/** Which of a member's calendars a new session should be written to.
 *
 * Every connected calendar is checked for conflicts, but exactly one receives
 * the invite: writing to all of them would produce several independent
 * calendar entries for one session, and cancelling would then have to find and
 * remove each. `is_primary` is the member's own choice on /me.
 *
 * The fallback for members who never chose is the OLDEST connection, not the
 * newest. Newest looks natural and is wrong twice over: connecting a second
 * calendar would silently move everyone's invites to it, and even reconnecting
 * an existing one would, since that resets connected_at. Oldest doesn't move
 * when calendars are added or repaired. In practice the fallback rarely
 * matters — the callback pins a choice the first time someone connects — but
 * it has to be stable for the rows that predate that.
 *
 * Callers pass the rows for ONE member; a mixed set returns a meaningless
 * answer. */
export function pickInviteConnection(rowsForOneMember: LatestConnectionRow[]) {
  if (rowsForOneMember.length === 0) return undefined;
  return (
    rowsForOneMember.find((r) => r.is_primary) ??
    [...rowsForOneMember].sort((a, b) => connectedAtMs(a) - connectedAtMs(b) || a.id - b.id)[0]
  );
}

/** Groups connections by member — the shape almost every caller now wants,
 * since "the connection for member X" stopped being a single row. */
export function groupConnectionsByMember(rows: LatestConnectionRow[]) {
  const byMember = new Map<number, LatestConnectionRow[]>();
  for (const row of rows) {
    const list = byMember.get(row.member_id) ?? [];
    list.push(row);
    byMember.set(row.member_id, list);
  }
  return byMember;
}

/** Same as `getLatestConnections`, filtered to members whose latest connection is
 * actually usable right now — connected AND under the currently active Nylas
 * app (see isConnectionUsable). */
export async function getActiveConnections(memberIds?: number[]) {
  const rows = await getLatestConnections(memberIds);
  return rows.filter(isConnectionUsable);
}

/** A single member's connection state, distinguishing three cases the UI
 * needs to tell apart: never connected, connected and usable, or connected
 * at some point but now stale (belongs to a different Nylas app than the one
 * currently configured — e.g. after switching Sandbox/Production tiers) and
 * needs reconnecting. */
export type MemberCalendar = {
  id: number;
  provider: string;
  grantEmail: string;
  /** True for the one that receives sessions. Exactly one usable calendar
   * carries this whenever the member has any. */
  isInviteTarget: boolean;
  /** Connected once, but under a Nylas app we no longer hold credentials for,
   * so nothing can be read from it. Listed rather than hidden: a calendar that
   * vanishes silently leaves the member believing it's still being checked,
   * with no way to repair it. */
  needsReconnect: boolean;
};

export async function getMemberConnectionState(memberId: number): Promise<{
  /** The calendar sessions are written to — what the header's status badge
   * shows. Null when nothing usable is connected. */
  connection: { provider: string; grantEmail: string } | null;
  /** All usable calendars, in connect order. Every one is checked for
   * conflicts; only `isInviteTarget` receives the invite. */
  calendars: MemberCalendar[];
  needsReconnect: boolean;
}> {
  const rows = await getLatestConnections([memberId]);
  const usable = rows.filter(isConnectionUsable);
  const invite = pickInviteConnection(usable);

  // Broken calendars are listed alongside working ones. Filtering them out
  // meant a member with one good and one stale calendar saw a tidy list, no
  // warning, and no Reconnect button — that only appeared once NOTHING worked.
  // They'd have gone on believing both were being checked.
  const listed = rows.filter(
    (r) => isConnectionUsable(r) || r.connection_status === "connected"
  );

  return {
    connection: invite ? { provider: invite.provider, grantEmail: invite.grant_email } : null,
    calendars: [...listed]
      .sort((a, b) => connectedAtMs(a) - connectedAtMs(b) || a.id - b.id)
      .map((r) => ({
        id: r.id,
        provider: r.provider,
        grantEmail: r.grant_email,
        isInviteTarget: r.id === invite?.id,
        needsReconnect: !isConnectionUsable(r),
      })),
    // Same reasoning as getMembersWithConnectionStatus: only when NOTHING
    // works, not merely because an old row is lying around.
    needsReconnect:
      usable.length === 0 && rows.some((r) => r.connection_status === "connected"),
  };
}

export type MemberWithConnection = {
  id: number;
  email: string;
  fullName: string;
  connected: boolean;
  // True when this member has a connection row that's marked "connected" but
  // belongs to a different Nylas app than the one currently configured — it
  // won't work for a search/booking (see isConnectionUsable) and needs a
  // fresh reconnect, as opposed to never having connected at all.
  needsReconnect: boolean;
  isFacilitator: boolean;
  /** Gates the Advisor picker in find-a-time, the way isFacilitator gates the
   * Session lead picker. Independent of both: someone can be an advisor and a
   * facilitator, or neither. */
  isAdvisor: boolean;
  /** Standing meeting links keyed by session length, e.g. `{ "30": "..." }`.
   * Carried so the booking form can prefill the lead's link for the length
   * being booked. */
  meetingLinks: Record<string, string>;
  /** The calendar that RECEIVES sessions, not "the" calendar — a member can
   * hold several. Null when none are usable. */
  provider: string | null;
  grantEmail: string | null;
  /** Every usable calendar this member holds, all of which are checked for
   * conflicts. Usually one. */
  connections: { provider: string; grantEmail: string; isInviteTarget: boolean }[];
};

/** Every member, each annotated with whether their latest connection is
 * currently active — for the admin find-a-time pickers' connected/not
 * connected filtering, and whether they're eligible to be picked as
 * "Session lead" (`isFacilitator` — a smaller set than "connected"; every
 * facilitator must also connect a calendar, but not every connected member
 * is a facilitator). */
export async function getMembersWithConnectionStatus(): Promise<MemberWithConnection[]> {
  const allMembers = await db.select().from(members).orderBy(members.fullName);
  const byMember = groupConnectionsByMember(
    await getLatestConnections(allMembers.map((m) => m.id))
  );

  return allMembers.map((m) => {
    const rows = byMember.get(m.id) ?? [];
    const usable = rows.filter(isConnectionUsable);
    const invite = pickInviteConnection(usable);
    return {
      id: m.id,
      email: m.email,
      fullName: m.fullName,
      connected: usable.length > 0,
      // Only "needs reconnect" when NONE of their calendars work. Someone with
      // a working calendar plus an old stale row is simply connected — nagging
      // them about the stale one would be noise.
      needsReconnect:
        usable.length === 0 && rows.some((r) => r.connection_status === "connected"),
      isFacilitator: m.isFacilitator,
      isAdvisor: m.isAdvisor,
      // Only carried so the booking form can prefill the meeting link for
      // whoever is leading. Everyone's links travel to the client, which is
      // fine: these are join URLs for meetings this admin is about to be in.
      meetingLinks: m.meetingLinks,
      provider: invite?.provider ?? null,
      grantEmail: invite?.grant_email ?? null,
      connections: usable.map((r) => ({
        provider: r.provider,
        grantEmail: r.grant_email,
        isInviteTarget: r.id === invite?.id,
      })),
    };
  });
}
