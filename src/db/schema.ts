import {
  pgTable,
  pgEnum,
  serial,
  integer,
  text,
  timestamp,
  uniqueIndex,
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

// `role` is descriptive metadata only — it does NOT grant /admin access.
// Admin access is purely the ADMIN_EMAILS env allowlist + signed session cookie.
export const members = pgTable("members", {
  id: serial("id").primaryKey(),
  email: text("email").notNull().unique(),
  fullName: text("full_name").notNull(),
  role: memberRoleEnum("role").notNull().default("member"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// `provider` is plain text (not a fixed enum) — stores whatever Nylas's
// exchange response reports (google/microsoft/icloud/etc.), so it doesn't
// need updating if Nylas adds providers later.
export const calendarConnections = pgTable("calendar_connections", {
  id: serial("id").primaryKey(),
  memberId: integer("member_id")
    .notNull()
    .references(() => members.id, { onDelete: "cascade" }),
  nylasGrantId: text("nylas_grant_id").notNull().unique(),
  provider: text("provider").notNull(),
  grantEmail: text("grant_email").notNull(),
  connectionStatus: connectionStatusEnum("connection_status")
    .notNull()
    .default("connected"),
  connectedAt: timestamp("connected_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
});

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
    // Nullable for historical reasons (a since-reverted design briefly
    // allowed free-typed guest emails with no member row) — every current
    // code path always sets this, since guests are member IDs again.
    memberId: integer("member_id").references(() => members.id),
    attendeeEmail: text("attendee_email").notNull(),
    responseStatus: attendeeResponseEnum("response_status")
      .notNull()
      .default("noreply"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [uniqueIndex("event_attendees_event_member_unique").on(t.eventId, t.memberId)]
);
