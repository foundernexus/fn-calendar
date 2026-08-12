import { NextResponse } from "next/server";
import { z } from "zod";
import {
  getActiveConnections,
  getMembersByIds,
  getMemberAvailabilityForMembers,
  getConfirmedEventsForMembers,
  getBookedEventsOverlapping,
} from "@/db/queries";
import { getCollectiveAvailability } from "@/lib/nylas";
import {
  zonedDateTimeToUnix,
  zonedDateTimeParts,
  nextDayString,
  formatSlotRange,
  isValidDateString,
  isValidTimeString,
  isOnIntervalBoundary,
  slotMatchesMemberAvailability,
  slotWithinWeeklyCap,
  weekStartDateString,
  TIMEZONES,
  AVAILABILITY_INTERVAL_MINUTES,
  type AvailabilityWindow,
} from "@/lib/time";
import { requireAdminSession } from "@/lib/auth/admin";

const TIMEZONE_VALUES = TIMEZONES.map((tz) => tz.value) as [string, ...string[]];

const bodySchema = z
  .object({
    organizerMemberId: z.number().int({ error: "Pick who's leading this session." }),
    guestMemberIds: z
      .array(z.number().int())
      .min(1, "Add at least one guest.")
      .max(49, "Add at most 49 guests.") // 49 + organizer = Nylas's 50-participant cap
      .refine((ids) => new Set(ids).size === ids.length, "Duplicate guest selected."),
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

  // The UI only ever offers connected members as options, but that's a
  // client-side filter, not a guarantee — someone could disconnect between
  // page load and search. Re-verify server-side rather than trusting it.
  // Deduped up front — the lead could theoretically also appear in
  // guestMemberIds (e.g. a stale selection from before they were picked as
  // lead), and counting the same person twice would desync `checkedCount`/
  // `totalSelected` from `notConnectedNames`.
  const allSelectedIds = [...new Set([body.organizerMemberId, ...body.guestMemberIds])];
  const [activeConnections, selectedMembers, availabilityRows] = await Promise.all([
    getActiveConnections(allSelectedIds),
    getMembersByIds(allSelectedIds),
    getMemberAvailabilityForMembers(allSelectedIds),
  ]);
  const connectionByMemberId = new Map(activeConnections.map((c) => [c.member_id, c]));
  const membersById = new Map(selectedMembers.map((m) => [m.id, m]));

  // Every selected member's (organizer + guests) own stated weekly windows,
  // grouped by member — see slotMatchesMemberAvailability for how this is
  // checked against each candidate slot below.
  const availabilityByMemberId = new Map<number, AvailabilityWindow[]>();
  for (const row of availabilityRows) {
    const list = availabilityByMemberId.get(row.memberId) ?? [];
    list.push({ dayOfWeek: row.dayOfWeek, startTime: row.startTime, endTime: row.endTime });
    availabilityByMemberId.set(row.memberId, list);
  }

  const organizerConnection = connectionByMemberId.get(body.organizerMemberId);
  if (!organizerConnection) {
    return NextResponse.json({
      slots: [],
      checkedCount: 0,
      totalSelected: allSelectedIds.length,
      notConnectedNames: [],
      error: "The selected session lead isn't connected. Connect their calendar first.",
    });
  }

  // The UI only offers facilitators as session-lead options — same
  // client-side-filter-isn't-a-guarantee reasoning as the connection check
  // above.
  if (!membersById.get(body.organizerMemberId)?.isFacilitator) {
    return NextResponse.json({
      slots: [],
      checkedCount: 0,
      totalSelected: allSelectedIds.length,
      notConnectedNames: [],
      error: "The selected session lead isn't a facilitator.",
    });
  }

  const notConnectedNames = allSelectedIds
    .filter((id) => !connectionByMemberId.has(id))
    .map((id) => membersById.get(id)?.fullName ?? `Unknown member #${id}`);

  // checkedCount/totalSelected count people (member IDs), not calendars —
  // keep this in the same unit as allSelectedIds/notConnectedNames above, or
  // two members sharing a connected account (deduped below by grant_email
  // for the actual Nylas call) would silently desync the two numbers shown
  // in the UI.
  const checkedCount = allSelectedIds.filter((id) => connectionByMemberId.has(id)).length;

  // Dedupe by grant_email, not member ID — two members could theoretically
  // share a connected account, and Nylas's participants list shouldn't carry
  // the same email twice.
  const participantEmails = [
    ...new Set(
      allSelectedIds
        .map((id) => connectionByMemberId.get(id))
        .filter((c) => c !== undefined)
        .map((c) => c.grant_email)
    ),
  ];

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
  let confirmedEvents;
  let bookedEvents;
  try {
    [slots, confirmedEvents, bookedEvents] = await Promise.all([
      getCollectiveAvailability({
        participantEmails,
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
      }),
      // ±7 day buffer, not ±1: a slot near either edge of [startDate, endDate]
      // can belong to a week that extends up to 6 days beyond that edge (e.g.
      // a single-day search on a Monday still needs that whole week's count,
      // including days after the search range) — a 1-day buffer only covered
      // slots right at the boundary and silently undercounted everything
      // else in that same week. 7 days guarantees the full week either side
      // is covered regardless of which weekday startDate/endDate land on, or
      // timezone-driven shifts in exactly where a guest's week starts.
      getConfirmedEventsForMembers(
        body.guestMemberIds,
        new Date((startTime - 7 * 86_400) * 1000),
        new Date((endTime + 7 * 86_400) * 1000)
      ),
      // Unlike the weekly-cap fetch above, this only needs to cover the
      // visible search range itself, not a buffered week either side — the
      // grid never renders cells outside [startDate, endDate] to begin with.
      getBookedEventsOverlapping(allSelectedIds, new Date(startTime * 1000), new Date(endTime * 1000)),
    ]);
  } catch (err) {
    console.error("[admin/availability] Nylas availability call failed", {
      startTime,
      endTime,
      participantCount: participantEmails.length,
      err,
    });
    return NextResponse.json(
      { error: "Couldn't reach Nylas to check availability. Please try again." },
      { status: 502 }
    );
  }

  // Every guest's already-booked CONFIRMED sessions, bucketed into weeks (in
  // their OWN timezone) — see slotWithinWeeklyCap for how this is checked
  // against each candidate slot below. Guests only, never the organizer —
  // see slotWithinWeeklyCap's own comment for why.
  const confirmedCountByMemberAndWeek = new Map<number, Map<string, number>>();
  for (const row of confirmedEvents) {
    const memberTimezone = membersById.get(row.memberId)?.timezone;
    if (!memberTimezone) continue;
    const { date } = zonedDateTimeParts(Math.floor(row.startsAt.getTime() / 1000), memberTimezone);
    const weekStart = weekStartDateString(date);
    const weekMap = confirmedCountByMemberAndWeek.get(row.memberId) ?? new Map<string, number>();
    weekMap.set(weekStart, (weekMap.get(weekStart) ?? 0) + 1);
    confirmedCountByMemberAndWeek.set(row.memberId, weekMap);
  }

  // Nylas only knows about real calendar free/busy — it has no idea a member
  // set "Mondays 2-5pm only" on /me, or that a guest is already at their
  // weekly session cap. Every selected member (organizer AND guests) must
  // individually clear their own stated availability window, checked in
  // each member's own timezone; guests must additionally still have room
  // under their own weekly cap for the week the slot falls in.
  const availableSlots = slots.filter(
    (slot) =>
      allSelectedIds.every((id) =>
        slotMatchesMemberAvailability(
          { startUnix: slot.startTime, endUnix: slot.endTime },
          membersById.get(id)?.timezone ?? null,
          availabilityByMemberId.get(id) ?? []
        )
      ) &&
      body.guestMemberIds.every((id) =>
        slotWithinWeeklyCap(
          { startUnix: slot.startTime },
          membersById.get(id)?.timezone ?? null,
          membersById.get(id)?.weeklySessionCap ?? Infinity,
          confirmedCountByMemberAndWeek.get(id) ?? new Map()
        )
      )
  );

  return NextResponse.json({
    slots: availableSlots.map((slot) => ({
      startUnix: slot.startTime,
      endUnix: slot.endTime,
      label: formatSlotRange(slot.startTime, slot.endTime, body.timezone),
    })),
    checkedCount,
    totalSelected: allSelectedIds.length,
    notConnectedNames,
    // True only when Nylas found real calendar overlap but every one of
    // those slots got excluded by someone's stated /me availability window —
    // distinct from Nylas finding nothing at all, so the UI isn't stuck
    // saying "no overlapping free time" when calendars genuinely overlap and
    // it's actually a stated preference doing the filtering.
    filteredByPreferences: slots.length > 0 && availableSlots.length === 0,
    // Real sessions already booked through this tool involving anyone
    // selected — shown on the grid as a distinct "already booked" cell
    // instead of an unexplained gray one.
    bookedSlots: bookedEvents.map((e) => ({
      startUnix: Math.floor(e.startsAt.getTime() / 1000),
      endUnix: Math.floor(e.endsAt.getTime() / 1000),
      title: e.title,
    })),
  });
}
