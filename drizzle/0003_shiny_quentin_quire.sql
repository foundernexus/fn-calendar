CREATE TABLE "member_availability" (
	"id" serial PRIMARY KEY NOT NULL,
	"member_id" integer NOT NULL,
	"day_of_week" integer NOT NULL,
	"start_time" text NOT NULL,
	"end_time" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "members" ADD COLUMN "timezone" text;--> statement-breakpoint
ALTER TABLE "members" ADD COLUMN "weekly_session_cap" integer DEFAULT 5 NOT NULL;--> statement-breakpoint
ALTER TABLE "member_availability" ADD CONSTRAINT "member_availability_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "member_availability_member_day_unique" ON "member_availability" USING btree ("member_id","day_of_week");