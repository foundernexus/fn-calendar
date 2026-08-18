CREATE TYPE "public"."attendee_role" AS ENUM('guest', 'advisor');--> statement-breakpoint
DROP INDEX "member_availability_member_day_unique";--> statement-breakpoint
ALTER TABLE "event_attendees" ADD COLUMN "role" "attendee_role" DEFAULT 'guest' NOT NULL;--> statement-breakpoint
ALTER TABLE "members" ADD COLUMN "is_advisor" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX "member_availability_member_day_idx" ON "member_availability" USING btree ("member_id","day_of_week");