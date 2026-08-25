CREATE TABLE "event_occurrences" (
	"id" serial PRIMARY KEY NOT NULL,
	"event_id" integer NOT NULL,
	"original_starts_at" timestamp with time zone NOT NULL,
	"status" text NOT NULL,
	"starts_at" timestamp with time zone,
	"ends_at" timestamp with time zone,
	"provider_instance_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "event_occurrences" ADD CONSTRAINT "event_occurrences_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "event_occurrences_event_original" ON "event_occurrences" USING btree ("event_id","original_starts_at");