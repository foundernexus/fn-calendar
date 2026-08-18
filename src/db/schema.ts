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
    nylasGrantId: text("nylas_grant_id").notNull().unique(),
    provider: text("provider").notNull(),
    grantEmail: text("grant_email").notNull(),
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
  },
  // Postgres doesn't auto-index FK columns, and getLatestConnections (used
  // on nearly every page load — /connect, /me, /admin/find-a-time) filters
  // and sorts by member_id on every call.
  (t) => [index("calendar_connections_member_id_idx").on(t.memberId)]
);

export const events = pgTable("events", {
  id: serial("id").primaryKey(),
  title: text("title").notNull(),
  description: text("description"),
  startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
  endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
  timezone: text("timezone").notNull(),
  meetingUrl: text("meeting_url"),
  organizerMemberId: integer("organizer_member_id")
    .notNull()
    .references(() => members.id),
  nylasEventId: text("nylas_event_id").notNull(),
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
