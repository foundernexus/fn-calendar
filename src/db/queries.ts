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
  nylas_grant_id: string;
  provider: string;
  grant_email: string;
  nylas_client_id: string | null;
  connection_status: "connected" | "revoked";
  connected_at: Date;
  revoked_at: Date | null;
};

/** A connection is only actually usable if it's marked connected AND belongs
 * to the Nylas app we're currently configured against — grants don't carry
 * over between Nylas apps (Sandbox vs Production, or after rotating to a new
 * app entirely), so a row with a stale nylas_client_id will fail at the
 * Nylas API regardless of what connection_status says. Rows from before this
 * column existed (nylas_client_id is null) are treated as stale rather than
 * assumed valid — we have no record of which app actually created them. */
export function isConnectionUsable(row: LatestConnectionRow) {
  return row.connection_status === "connected" && row.nylas_client_id === env.NYLAS_CLIENT_ID;
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

  const result = await db.execute<LatestConnectionRow>(sql`
    SELECT DISTINCT ON (member_id) *
    FROM ${calendarConnections}
    ${memberFilter}
    ORDER BY member_id, connected_at DESC, id DESC
  `);

  return result.rows;
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
export async function getMemberConnectionState(memberId: number): Promise<{
  connection: { provider: string; grantEmail: string } | null;
  needsReconnect: boolean;
}> {
  const [row] = await getLatestConnections([memberId]);
  if (!row) return { connection: null, needsReconnect: false };
  if (isConnectionUsable(row)) {
    return { connection: { provider: row.provider, grantEmail: row.grant_email }, needsReconnect: false };
  }
  return { connection: null, needsReconnect: row.connection_status === "connected" };
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
  provider: string | null;
  grantEmail: string | null;
};

/** Every member, each annotated with whether their latest connection is
 * currently active — for the admin find-a-time pickers' connected/not
 * connected filtering, and whether they're eligible to be picked as
 * "Session lead" (`isFacilitator` — a smaller set than "connected"; every
 * facilitator must also connect a calendar, but not every connected member
 * is a facilitator). */
export async function getMembersWithConnectionStatus(): Promise<MemberWithConnection[]> {
  const allMembers = await db.select().from(members).orderBy(members.fullName);
  const latest = await getLatestConnections(allMembers.map((m) => m.id));
  const latestByMember = new Map(latest.map((row) => [row.member_id, row]));

  return allMembers.map((m) => {
    const connection = latestByMember.get(m.id);
    const usable = !!connection && isConnectionUsable(connection);
    return {
      id: m.id,
      email: m.email,
      fullName: m.fullName,
      connected: usable,
      needsReconnect: !!connection && connection.connection_status === "connected" && !usable,
      isFacilitator: m.isFacilitator,
      isAdvisor: m.isAdvisor,
      provider: usable ? connection!.provider : null,
      grantEmail: usable ? connection!.grant_email : null,
    };
  });
}
