import { sql } from "drizzle-orm";
import {
  pgTable,
  pgEnum,
  serial,
  integer,
  text,
  timestamp,
  uniqueIndex,
  index,
  boolean,
  jsonb,
} from "drizzle-orm/pg-core";

export const memberRoleEnum = pgEnum("member_role", ["member", "admin"]);
export const connectionStatusEnum = pgEnum("connection_status", [
  "connected",
  "revoked",
]);
export const eventStatusEnum = pgEnum("event_status", [
  "confirmed",
  "cancelled",
]);
export const attendeeResponseEnum = pgEnum("attendee_response_status", [
  "noreply",
  "yes",
  "no",
  "maybe",
]);

// What someone was IN a given session, as opposed to what they are in general
// (`members.isAdvisor`). The same person can be the advisor on one session and
// an ordinary guest on another, so this can't live on `members` — it mirrors
// the existing split between `isFacilitator` (who may lead) and
// `events.organizerMemberId` (who actually led).
export const attendeeRoleEnum = pgEnum("attendee_role", ["guest", "advisor"]);

// `role` is descriptive metadata only — it does NOT grant /admin access.
// Admin access is purely the ADMIN_EMAILS env allowlist + signed session cookie.
export const members = pgTable("members", {
  id: serial("id").primaryKey(),
  email: text("email").notNull().unique(),
  fullName: text("full_name").notNull(),
  role: memberRoleEnum("role").notNull().default("member"),
  // Gates who can be picked as a session's "Session lead" in the find-a-time
  // UI — connecting a calendar alone is NOT enough (that's what makes a
  // member eligible as a guest). A curated, small set of people actually run
  // sessions; everyone else who connects is a guest-only participant.
  isFacilitator: boolean("is_facilitator").notNull().default(false),
  // Gates who appears in find-a-time's Advisor picker, exactly as
  // `isFacilitator` gates the Session lead picker. Also decides where /connect
  // lands them afterwards: advisors go to /advisor, everyone else to /me.
  // Like `role`, this grants no admin access — that stays ADMIN_EMAILS-only.
  isAdvisor: boolean("is_advisor").notNull().default(false),
  // Nullable — no guessed default for a global membership. Null means the
  // member has never saved their /me settings yet; the client suggests the
  // browser-detected zone in that case but writes nothing until they save.
  timezone: text("timezone"),
  // Unused. Nothing reads or writes this any more: the weekly session cap was
  // removed after it turned out advisors were the only ones who could set it
  // and founders the only ones it applied to. Kept rather than dropped — a
  // migration against production buys nothing here, and the column is where
  // the number would live if the idea ever comes back.
  weeklySessionCap: integer("weekly_session_cap").notNull().default(5),
  // Quiet time kept either side of anything already in this person's calendar,
  // in minutes. Applied when their free time is worked out, so a slot butted up
  // against an existing meeting is simply never offered.
  //
  // This exists because of what a Nexus Partner's day is actually made of: back
  // to back calls, each of which needs a tailored follow-up written afterwards.
  // Without a gap that work slides to the evening — "I got this email sent out
  // at like 8 o'clock at night" — and the next call starts before the last one
  // has been dealt with.
  //
  // Zero for everyone by default. A founder being scheduled into the occasional
  // session has no reason to want it, and a default that silently narrows
  // people's availability would be the wrong kind of helpful.
  bufferBeforeMinutes: integer("buffer_before_minutes").notNull().default(0),
  bufferAfterMinutes: integer("buffer_after_minutes").notNull().default(0),
  // Standing meeting links, keyed by session length in minutes:
  // `{ "15": "https://zoom.us/j/...", "30": "..." }`.
  //
  // Keyed by length rather than a single default because that is how these are
  // actually held: a Nexus Partner has one standing room for a fifteen-minute
  // member check-in and a different one for a thirty-minute intro. One field
  // would have covered neither of them properly.
  //
  // jsonb rather than a column per length so adding a duration doesn't cost a
  // migration. Validated on write — see /api/me.
  meetingLinks: jsonb("meeting_links").$type<Record<string, string>>().notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// `provider` is plain text (not a fixed enum) — stores whatever Nylas's
// exchange response reports (google/microsoft/icloud/etc.), so it doesn't
// need updating if Nylas adds providers later.
export const calendarConnections = pgTable(
  "calendar_connections",
  {
    id: serial("id").primaryKey(),
    memberId: integer("member_id")
      .notNull()
      .references(() => members.id, { onDelete: "cascade" }),
    // Nullable since the switch to talking to Google and Microsoft directly:
    // rows created that way have no Nylas grant at all. Still unique, so the
    // remaining Nylas rows can't collide while they're being retired.
    nylasGrantId: text("nylas_grant_id").unique(),
    provider: text("provider").notNull(),
    grantEmail: text("grant_email").notNull(),
    // The OAuth refresh token, encrypted (see lib/calendar/crypto.ts). This is
    // what replaced the Nylas grant: a long-lived credential we now hold
    // ourselves rather than delegate.
    //
    // Its presence is what makes a row usable. The Nylas rows that predate the
    // switch have none, so they read as "needs reconnect" through the existing
    // machinery without any special case — which is exactly the prompt those
    // members need to see.
    refreshTokenEncrypted: text("refresh_token_encrypted"),
    // Short-lived, cached only to avoid a refresh round trip on every single
    // availability search. Losing it costs one extra request, never a
    // connection, so it is safe to clear at any time.
    accessTokenEncrypted: text("access_token_encrypted"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
    // Which Nylas application (client_id) this grant was created under —
    // grants aren't portable between Nylas apps (e.g. Sandbox vs Production,
    // or after rotating to a new app), so a row whose nylasClientId doesn't
    // match the currently active env.NYLAS_CLIENT_ID is unusable even though
    // connectionStatus still says "connected". Nullable: rows created before
    // this column existed have no recorded value and are treated as stale
    // (see isConnectionUsable in db/queries.ts).
    nylasClientId: text("nylas_client_id"),
    connectionStatus: connectionStatusEnum("connection_status")
      .notNull()
      .default("connected"),
    connectedAt: timestamp("connected_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    // Which of this member's calendars new sessions get written to. A member
    // can connect several (a personal Google and a work Google, say): ALL of
    // them are checked for conflicts, but the invite has to land on exactly
    // one, or a single session becomes three separate calendar entries that
    // cancel independently.
    //
    // False everywhere is a valid state — see pickInviteConnection in
    // db/queries.ts, which falls back to the most recently connected calendar.
    // That keeps every existing single-calendar member working with no
    // backfill.
    isPrimary: boolean("is_primary").notNull().default(false),
  },
  (t) => [
    // Postgres doesn't auto-index FK columns, and getLatestConnections (used
    // on nearly every page load — /connect, /me, /admin/find-a-time) filters
    // and sorts by member_id on every call.
    index("calendar_connections_member_id_idx").on(t.memberId),
    // At most one primary per member, enforced by the database rather than by
    // remembering to clear the old one: a member with two calendars both
    // claiming the invite would make which calendar receives a session depend
    // on row order.
    uniqueIndex("calendar_connections_one_primary_per_member")
      .on(t.memberId)
      .where(sql`${t.isPrimary}`),
  ]
);

export const events = pgTable("events", {
  id: serial("id").primaryKey(),
  /** How often this session repeats, as an RFC 5545 rule — the string we hand
   * the provider, e.g. `RRULE:FREQ=WEEKLY;INTERVAL=4;COUNT=6`. Null for the
   * ordinary one-off, which is nearly all of them.
   *
   * Stored so the app can say "this cancels all six" before someone cancels all
   * six. Nothing else reads it: the later occurrences are real events in real
   * calendars, so free/busy reports them and the grid greys them out without
   * anyone here expanding a series.
   *
   * Deliberately no per-occurrence rows. Moving one instance of a series is
   * something Google already does well, in the calendar everyone involved
   * already has open; matching it here would mean tracking exceptions and
   * giving up this table as the answer to "when is this session". */
  recurrenceRule: text("recurrence_rule"),
  title: text("title").notNull(),
  description: text("description"),
  startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
  endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
  timezone: text("timezone").notNull(),
  meetingUrl: text("meeting_url"),
  organizerMemberId: integer("organizer_member_id")
    .notNull()
    .references(() => members.id),
  // Nullable since the switch away from Nylas — see provider_event_id below,
  // which is where new bookings record their id.
  nylasEventId: text("nylas_event_id"),
  /** The event id as Google or Microsoft knows it. Needed to move or cancel
   * the session later, and meaningless without knowing WHICH connection it was
   * created on — hence organizerConnectionId below. */
  providerEventId: text("provider_event_id"),
  /** The connection the event was actually created on, pinned at booking time.
   *
   * Same reasoning as organizerGrantId before it: looking the organiser's
   * calendar up fresh would silently target the wrong one the moment they
   * change which calendar receives invites, and the cancellation would fail
   * while the meeting sat in everyone's diary. Deliberately no foreign key —
   * removing a calendar must not cascade away the record of sessions booked
   * from it. */
  organizerConnectionId: integer("organizer_connection_id"),
  // The grant the event was actually created on. Nylas resolves an event id
  // within a grant, so cancelling or moving it has to use the same one —
  // and now that a member can hold several calendars, "the organizer's
  // connection" is no longer a single unambiguous answer. Looking it up fresh
  // would silently target the wrong calendar the moment they change which one
  // receives invites, and the cancel would 404 while the meeting stayed in
  // everyone's diary. Nullable: rows created before this column existed fall
  // back to the lookup (see api/admin/events/[id]).
  organizerGrantId: text("organizer_grant_id"),
  status: eventStatusEnum("status").notNull().default("confirmed"),
  // Hash of sorted guest member IDs + slot start + duration (organizer
  // intentionally excluded — same guest list + same time is always a
  // duplicate, regardless of who's leading the session).
  idempotencyKey: text("idempotency_key").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const eventAttendees = pgTable(
  "event_attendees",
  {
    id: serial("id").primaryKey(),
    eventId: integer("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    memberId: integer("member_id")
      .notNull()
      .references(() => members.id),
    attendeeEmail: text("attendee_email").notNull(),
    role: attendeeRoleEnum("role").notNull().default("guest"),
    responseStatus: attendeeResponseEnum("response_status")
      .notNull()
      .default("noreply"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [uniqueIndex("event_attendees_event_member_unique").on(t.eventId, t.memberId)]
);

// A member's own weekly availability preference, set on /me — checked by the
// admin's find-a-time search (see slotMatchesMemberAvailability in
// src/lib/time.ts) on top of real calendar free/busy, not instead of it.
export const memberAvailability = pgTable(
  "member_availability",
  {
    id: serial("id").primaryKey(),
    memberId: integer("member_id")
      .notNull()
      .references(() => members.id, { onDelete: "cascade" }),
    // 0=Sunday..6=Saturday — same convention as `dayOfWeek()` in src/lib/time.ts.
    dayOfWeek: integer("day_of_week").notNull(),
    // "HH:mm", same string format used for workingHoursStart/End elsewhere.
    // No row for a given (memberId, dayOfWeek) means that day is off — there's
    // no separate `enabled` boolean to keep in sync.
    startTime: text("start_time").notNull(),
    endTime: text("end_time").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  // Deliberately NOT unique on (member_id, day_of_week): a member can have
  // several blocks in one day, e.g. 09:00–12:00 and 14:00–17:00 around lunch.
  // Non-overlap and start<end are enforced in api/me/route.ts, not here —
  // Postgres can't express "no two ranges for this member on this day
  // overlap" without an exclusion constraint over a range type, which would
  // mean storing these as ranges rather than the "HH:mm" text the rest of the
  // app compares against.
  (t) => [index("member_availability_member_day_idx").on(t.memberId, t.dayOfWeek)]
);
