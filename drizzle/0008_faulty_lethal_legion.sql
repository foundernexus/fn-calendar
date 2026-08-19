ALTER TABLE "calendar_connections" ALTER COLUMN "nylas_grant_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "events" ALTER COLUMN "nylas_event_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "calendar_connections" ADD COLUMN "refresh_token_encrypted" text;--> statement-breakpoint
ALTER TABLE "calendar_connections" ADD COLUMN "access_token_encrypted" text;--> statement-breakpoint
ALTER TABLE "calendar_connections" ADD COLUMN "access_token_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "provider_event_id" text;--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "organizer_connection_id" integer;