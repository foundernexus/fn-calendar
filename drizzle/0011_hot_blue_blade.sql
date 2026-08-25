CREATE TABLE "session_conflicts" (
	"id" serial PRIMARY KEY NOT NULL,
	"event_id" integer NOT NULL,
	"occurrence_starts_at" timestamp with time zone NOT NULL,
	"conflicting_names" text NOT NULL,
	"detected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "session_conflicts" ADD CONSTRAINT "session_conflicts_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "session_conflicts_event_occurrence" ON "session_conflicts" USING btree ("event_id","occurrence_starts_at");