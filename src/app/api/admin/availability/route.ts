import { NextResponse } from "next/server";
import { z } from "zod";
import { getActiveConnections, getMembersByIds } from "@/db/queries";
import { getCollectiveAvailability } from "@/lib/nylas";
import {
  zonedDateTimeToUnix,
  nextDayString,
  formatSlotRange,
  isValidDateString,
  isValidTimeString,
  TIMEZONES,
} from "@/lib/time";
import { requireAdminSession } from "@/lib/auth/admin";

const TIMEZONE_VALUES = TIMEZONES.map((tz) => tz.value) as [string, ...string[]];

const bodySchema = z
  .object({
    memberIds: z
      .array(z.number().int())
      .min(1)
      .max(50) // 50 = Nylas's participant cap
      .refine((ids) => new Set(ids).size === ids.length, "Duplicate member selected."),
    startDate: z.string().refine(isValidDateString, "Invalid start date."),
    endDate: z.string().refine(isValidDateString, "Invalid end date."),
    durationMinutes: z.union([z.literal(30), z.literal(45), z.literal(60)]),
    workingHoursStart: z.string().refine(isValidTimeString, "Invalid start time."),
    workingHoursEnd: z.string().refine(isValidTimeString, "Invalid end time."),
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

  // Only the connected subset can actually be checked — Nylas has no free/busy
  // data for anyone who hasn't connected. Participants are queried by their
  // connected calendar's grant_email, NOT members.email (those can differ).
  const [activeConnections, selectedMembers] = await Promise.all([
    getActiveConnections(body.memberIds),
    getMembersByIds(body.memberIds),
  ]);
  const connectedMemberIds = new Set(activeConnections.map((c) => c.member_id));
  const membersById = new Map(selectedMembers.map((m) => [m.id, m]));
  const notConnectedNames = body.memberIds
    .filter((id) => !connectedMemberIds.has(id))
    .map((id) => membersById.get(id)?.fullName ?? `Unknown member #${id}`);

  if (activeConnections.length === 0) {
    return NextResponse.json({
      slots: [],
      checkedCount: 0,
      totalSelected: body.memberIds.length,
      notConnectedNames,
      error: "None of the selected members have connected their calendar yet.",
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
      participantEmails: activeConnections.map((c) => c.grant_email),
      startTime,
      endTime,
      durationMinutes: body.durationMinutes,
      timezone: body.timezone,
      workingHoursStart: body.workingHoursStart,
      workingHoursEnd: body.workingHoursEnd,
      excludeWeekends: body.excludeWeekends,
    });
  } catch (err) {
    console.error("[admin/availability] Nylas availability call failed", {
      startTime,
      endTime,
      participantCount: activeConnections.length,
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
    checkedCount: activeConnections.length,
    totalSelected: body.memberIds.length,
    notConnectedNames,
  });
}
