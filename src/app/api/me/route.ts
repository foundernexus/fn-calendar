import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
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

/** A day can hold several blocks — e.g. 09:00–12:00 and 14:00–17:00 around
 * lunch. Capped so one member can't write unbounded rows, and because the
 * settings UI stops offering "add block" at the same limit. */
const MAX_BLOCKS_PER_DAY = 3;

/** Keys a standing meeting link can be stored under.
 *
 * "default" is the one the form writes and the only one anybody uses: a
 * personal meeting room is a single room, so the same link serves every call
 * whatever its length. The per-length keys are still accepted because the
 * column briefly held them and the shape cost nothing to keep — if a reason to
 * vary the link by length ever turns up, it fits without a migration. */
const LINK_KEYS = ["default", "15", "30", "45", "60"] as const;

/** Quiet time either side of a meeting. Capped at an hour: past that it stops
 * being a buffer and becomes availability, which belongs in the weekly hours
 * above where it is visible rather than hidden in a number. */
const bufferSchema = z.number().int().min(0).max(60);

const bodySchema = z.object({
  timezone: z.string().refine(isSupportedTimezone, "Unsupported timezone."),
  // Optional throughout so an older client that only knows how to save hours
  // keeps working, and doesn't silently wipe a buffer it never sent.
  bufferBeforeMinutes: bufferSchema.optional(),
  bufferAfterMinutes: bufferSchema.optional(),
  meetingLinks: z
    .record(z.enum(LINK_KEYS), z.string().trim().url("Enter a valid link.").or(z.literal("")))
    .optional(),
  availability: z
    .array(dayEntrySchema)
    .max(7 * MAX_BLOCKS_PER_DAY)
    .superRefine((days, ctx) => {
      const byDay = new Map<number, typeof days>();
      for (const d of days) {
        const list = byDay.get(d.dayOfWeek) ?? [];
        list.push(d);
        byDay.set(d.dayOfWeek, list);
      }

      for (const [dayOfWeek, blocks] of byDay) {
        if (blocks.length > MAX_BLOCKS_PER_DAY) {
          ctx.addIssue({
            code: "custom",
            message: `At most ${MAX_BLOCKS_PER_DAY} time blocks per day.`,
          });
          continue;
        }
        // Overlapping blocks aren't just untidy — slotMatchesMemberAvailability
        // asks whether a slot fits inside ANY block, so overlaps silently widen
        // availability in ways the member can't see on the form.
        const sorted = [...blocks].sort((a, b) => a.startTime.localeCompare(b.startTime));
        for (let i = 1; i < sorted.length; i++) {
          if (sorted[i].startTime < sorted[i - 1].endTime) {
            ctx.addIssue({
              code: "custom",
              message: `Overlapping time blocks on the same day (${sorted[i - 1].startTime}–${sorted[i - 1].endTime} and ${sorted[i].startTime}–${sorted[i].endTime}).`,
              path: [dayOfWeek],
            });
            break;
          }
        }
      }
    }),
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

  try {
    // Buffers and links ride along in the same statement as the timezone, so a
    // single Save means what it says. Only written when sent — an absent field
    // is "this client didn't ask", not "clear it".
    const saveTimezone = db
      .update(members)
      .set({
        timezone: body.timezone,
        ...(body.bufferBeforeMinutes === undefined
          ? {}
          : { bufferBeforeMinutes: body.bufferBeforeMinutes }),
        ...(body.bufferAfterMinutes === undefined
          ? {}
          : { bufferAfterMinutes: body.bufferAfterMinutes }),
        ...(body.meetingLinks === undefined
          ? {}
          : {
              // Blanks are dropped rather than stored as "". A cleared field
              // means "I have no standing link for this length", and an empty
              // string would later be prefilled into the booking form as one.
              meetingLinks: Object.fromEntries(
                Object.entries(body.meetingLinks).filter(([, url]) => url && url.trim() !== "")
              ),
            }),
      })
      .where(eq(members.id, memberId));

    // Replace this member's blocks wholesale rather than upserting per day.
    // Now that a day can hold several blocks there's no longer a unique
    // (member, day) key to upsert against, and "which of today's three rows
    // does this one replace?" has no good answer — the form always submits
    // the complete set, so deleting and re-inserting is both simpler and
    // exactly right.
    //
    // db.batch() runs these in a single Neon transaction, so a failure can't
    // leave the member with their availability deleted and nothing written
    // back. Deleting and inserting as two separate awaits could.
    //
    // The timezone save belongs in the SAME transaction, not before it. A
    // member's timezone being null is what marks them as "never saved, treat
    // as unconstrained" (see slotMatchesMemberAvailability); the moment it's
    // set, their blocks apply strictly. Writing it separately meant a first
    // save whose block insert failed left them with a timezone and zero
    // blocks — which reads as "available never" — while the form showed
    // success. They'd have vanished from every search with nothing to explain
    // it.
    const deleteExisting = db
      .delete(memberAvailability)
      .where(eq(memberAvailability.memberId, memberId));

    if (body.availability.length > 0) {
      await db.batch([
        saveTimezone,
        deleteExisting,
        db.insert(memberAvailability).values(
          body.availability.map((d) => ({
            memberId,
            dayOfWeek: d.dayOfWeek,
            startTime: d.startTime,
            endTime: d.endTime,
          }))
        ),
      ]);
    } else {
      // Deliberately every day off. Still one transaction: the timezone must
      // not land without the delete that goes with it.
      await db.batch([saveTimezone, deleteExisting]);
    }
  } catch (err) {
    console.error("[api/me] Save failed", { memberId, err });
    return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 });
  }

  return NextResponse.json({
    timezone: body.timezone,
    availability: body.availability,
  });
}
