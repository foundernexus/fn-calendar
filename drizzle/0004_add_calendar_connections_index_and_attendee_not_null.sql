ALTER TABLE "event_attendees" ALTER COLUMN "member_id" SET NOT NULL;--> statement-breakpoint
CREATE INDEX "calendar_connections_member_id_idx" ON "calendar_connections" USING btree ("member_id");