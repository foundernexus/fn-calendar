CREATE TYPE "public"."attendee_response_status" AS ENUM('noreply', 'yes', 'no', 'maybe');--> statement-breakpoint
CREATE TYPE "public"."connection_status" AS ENUM('connected', 'revoked');--> statement-breakpoint
CREATE TYPE "public"."event_status" AS ENUM('confirmed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."member_role" AS ENUM('member', 'admin');--> statement-breakpoint
CREATE TABLE "calendar_connections" (
	"id" serial PRIMARY KEY NOT NULL,
	"member_id" integer NOT NULL,
	"nylas_grant_id" text NOT NULL,
	"provider" text NOT NULL,
	"grant_email" text NOT NULL,
	"connection_status" "connection_status" DEFAULT 'connected' NOT NULL,
	"connected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "calendar_connections_nylas_grant_id_unique" UNIQUE("nylas_grant_id")
);
--> statement-breakpoint
CREATE TABLE "event_attendees" (
	"id" serial PRIMARY KEY NOT NULL,
	"event_id" integer NOT NULL,
	"member_id" integer NOT NULL,
	"attendee_email" text NOT NULL,
	"response_status" "attendee_response_status" DEFAULT 'noreply' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" serial PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"timezone" text NOT NULL,
	"meeting_url" text,
	"organizer_member_id" integer NOT NULL,
	"nylas_event_id" text NOT NULL,
	"status" "event_status" DEFAULT 'confirmed' NOT NULL,
	"idempotency_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "events_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "members" (
	"id" serial PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"full_name" text NOT NULL,
	"role" "member_role" DEFAULT 'member' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "members_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "calendar_connections" ADD CONSTRAINT "calendar_connections_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_attendees" ADD CONSTRAINT "event_attendees_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_attendees" ADD CONSTRAINT "event_attendees_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_organizer_member_id_members_id_fk" FOREIGN KEY ("organizer_member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "event_attendees_event_member_unique" ON "event_attendees" USING btree ("event_id","member_id");