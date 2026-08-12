import { NextResponse } from "next/server";
import { eq, and, notInArray, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { members, memberAvailability } from "@/db/schema";
import { requireMemberSession } from "@/lib/auth/member";
import { isValidTimeString } from "@/lib/time";
import { isSupportedTimezone } from "@/lib/timezones";

const dayEntrySchema = z
  .object({
    dayOfWeek: z.number().int().min(0).max(6),
    startTime: z.string().refine(isValidTimeString, "Invalid start time."),
    endTime: z.string().refine(isValidTimeString, "Invalid end time."),
  })
  .refine((d) => d.endTime > d.startTime, {
    message: "End time must be after start time.",
    path: ["endTime"],
  });

const bodySchema = z.object({
  timezone: z.string().refine(isSupportedTimezone, "Unsupported timezone."),
  weeklySessionCap: z.number().int().min(0).max(50),
  availability: z
    .array(dayEntrySchema)
    .max(7)
    .refine(
      (days) => new Set(days.map((d) => d.dayOfWeek)).size === days.length,
      "Duplicate day."
    ),
});

export async function PATCH(request: Request) {
  const session = await requireMemberSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid request." },
      { status: 400 }
    );
  }
  const body = parsed.data;
  const memberId = session.memberId;
  const enabledDays = body.availability.map((d) => d.dayOfWeek);

  try {
    await db
      .update(members)
      .set({ timezone: body.timezone, weeklySessionCap: body.weeklySessionCap })
      .where(eq(members.id, memberId));

    // Upsert enabled days before deleting now-disabled ones — with no
    // multi-statement transaction available (Neon HTTP driver), if the
    // delete step below fails, the worst case is a day that should be off
    // staying on with stale times, not any lost data. The reverse order
    // risks the opposite: a day the member just re-enabled being deleted
    // right back out from under them.
    if (body.availability.length > 0) {
      await db
        .insert(memberAvailability)
        .values(
          body.availability.map((d) => ({
            memberId,
            dayOfWeek: d.dayOfWeek,
            startTime: d.startTime,
            endTime: d.endTime,
          }))
        )
        .onConflictDoUpdate({
          target: [memberAvailability.memberId, memberAvailability.dayOfWeek],
          set: {
            startTime: sql`excluded.start_time`,
            endTime: sql`excluded.end_time`,
          },
        });
    }

    if (enabledDays.length > 0) {
      await db
        .delete(memberAvailability)
        .where(
          and(
            eq(memberAvailability.memberId, memberId),
            notInArray(memberAvailability.dayOfWeek, enabledDays)
          )
        );
    } else {
      // notInArray(..., []) would generate an invalid/no-op "NOT IN ()" —
      // every day is off, so every row for this member should go.
      await db.delete(memberAvailability).where(eq(memberAvailability.memberId, memberId));
    }
  } catch (err) {
    console.error("[api/me] Save failed", { memberId, err });
    return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 });
  }

  return NextResponse.json({
    timezone: body.timezone,
    weeklySessionCap: body.weeklySessionCap,
    availability: body.availability,
  });
}
