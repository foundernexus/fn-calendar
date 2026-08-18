ALTER TABLE "calendar_connections" ADD COLUMN "is_primary" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "organizer_grant_id" text;--> statement-breakpoint
CREATE UNIQUE INDEX "calendar_connections_one_primary_per_member" ON "calendar_connections" USING btree ("member_id") WHERE "calendar_connections"."is_primary";