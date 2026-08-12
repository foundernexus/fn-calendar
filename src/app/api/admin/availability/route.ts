import { NextResponse } from "next/server";
import { z } from "zod";
import { getActiveConnections } from "@/db/queries";
import { getCollectiveAvailability } from "@/lib/nylas";
import {
  zonedDateTimeToUnix,
  nextDayString,
  formatSlotRange,
  isValidDateString,
  isValidTimeString,
  isOnIntervalBoundary,
  TIMEZONES,
  AVAILABILITY_INTERVAL_MINUTES,
} from "@/lib/time";
import { requireAdminSession } from "@/lib/auth/admin";

const TIMEZONE_VALUES = TIMEZONES.map((tz) => tz.value) as [string, ...string[]];

const bodySchema = z
  .object({
    organizerMemberId: z.number().int({ error: "Pick who's leading this session." }),
    startDate: z.string().refine(isValidDateString, "Invalid start date."),
    endDate: z.string().refine(isValidDateString, "Invalid end date."),
    durationMinutes: z.union([z.literal(30), z.literal(45), z.literal(60)]),
    workingHoursStart: z
      .string()
      .refine(isValidTimeString, "Invalid start time.")
      .refine(isOnIntervalBoundary, "Working hours start must be on a 30-minute mark (e.g. 9:00 or 9:30)."),
    workingHoursEnd: z
      .string()
      .refine(isValidTimeString, "Invalid end time.")
      .refine(isOnIntervalBoundary, "Working hours end must be on a 30-minute mark (e.g. 5:00 or 5:30)."),
    timezone: z.enum(TIMEZONE_VALUES),
    excludeWeekends: z.boolean(),
  })
  .refine((b) => b.endDate >= b.startDate, {
    message: "End date must be on or after start date.",
    path: ["endDate"],
  })
  .refine((b) => b.workingHoursEnd > b.workingHoursStart, {
    message: "Working hours end must be after start.",
    path: ["workingHoursEnd"],
  })
  .refine((b) => (Date.parse(b.endDate) - Date.parse(b.startDate)) / 86_400_000 <= 60, {
    message: "Date range can't span more than 60 days.",
    path: ["endDate"],
  });

export async function POST(request: Request) {
  // proxy.ts already blocks unauthenticated requests to /api/admin/*, but per
  // Next's own guidance, don't rely on Proxy alone as the only gate.
  const session = await requireAdminSession();
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

  // Only the session lead's own calendar is checked — guests are free-typed
  // emails with no calendar connection on file (the whole point: an outside
  // expert or a member who's never connected shouldn't block scheduling).
  const [organizerConnection] = await getActiveConnections([body.organizerMemberId]);
  if (!organizerConnection) {
    return NextResponse.json({
      slots: [],
      error: "The selected session lead isn't connected. Connect their calendar first.",
    });
  }

  // Nylas requires start_time/end_time to be exact multiples of 5 minutes.
  // Midnight always qualifies (every supported timezone's UTC offset is a
  // whole number of hours); "23:59" never does — so the end boundary is
  // built as the NEXT day's midnight, not the last minute of endDate.
  const startTime = zonedDateTimeToUnix(body.startDate, "00:00", body.timezone);
  const endTime = zonedDateTimeToUnix(nextDayString(body.endDate), "00:00", body.timezone);
  if (!Number.isFinite(startTime) || !Number.isFinite(endTime)) {
    return NextResponse.json({ error: "Invalid date range." }, { status: 400 });
  }

  let slots;
  try {
    slots = await getCollectiveAvailability({
      participantEmails: [organizerConnection.grant_email],
      startTime,
      endTime,
      durationMinutes: body.durationMinutes,
      // Explicit rather than relying on the Nylas wrapper's own default —
      // the grid's row spacing (AVAILABILITY_INTERVAL_MINUTES) must match
      // this exactly or slots won't land on the rows the grid generates.
      intervalMinutes: AVAILABILITY_INTERVAL_MINUTES,
      timezone: body.timezone,
      workingHoursStart: body.workingHoursStart,
      workingHoursEnd: body.workingHoursEnd,
      excludeWeekends: body.excludeWeekends,
    });
  } catch (err) {
    console.error("[admin/availability] Nylas availability call failed", {
      startTime,
      endTime,
      err,
    });
    return NextResponse.json(
      { error: "Couldn't reach Nylas to check availability. Please try again." },
      { status: 502 }
    );
  }

  return NextResponse.json({
    slots: slots.map((slot) => ({
      startUnix: slot.startTime,
      endUnix: slot.endTime,
      label: formatSlotRange(slot.startTime, slot.endTime, body.timezone),
    })),
  });
}
