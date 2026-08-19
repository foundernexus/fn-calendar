import { NextResponse } from "next/server";
import { z } from "zod";
import {
  getActiveConnections,
  groupConnectionsByMember,
  getMembersByIds,
  getMemberAvailabilityForMembers,
  getBookedEventsOverlapping,
} from "@/db/queries";
import { getCollectiveAvailability } from "@/lib/calendar/availability";
import { connectionCredentials } from "@/db/queries";
import {
  zonedDateTimeToUnix,
  zonedDateTimeParts,
  nextDayString,
  formatSlotRange,
  isValidDateString,
  isValidTimeString,
  isOnIntervalBoundary,
  slotMatchesMemberAvailability,
  TIMEZONES,
  AVAILABILITY_INTERVAL_MINUTES,
  type AvailabilityWindow,
} from "@/lib/time";
import { requireAdminSession } from "@/lib/auth/admin";

const TIMEZONE_VALUES = TIMEZONES.map((tz) => tz.value) as [string, ...string[]];

const bodySchema = z
  .object({
    organizerMemberId: z.number().int({ error: "Pick who's leading this session." }),
    // Optional: plenty of sessions have no advisor. Nullish rather than
    // required so an older client that doesn't send the field still works.
    advisorMemberId: z.number().int().nullish(),
    guestMemberIds: z
      .array(z.number().int())
      .min(1, "Add at least one founder.")
      .max(49, "Add at most 49 founders.") // 49 + organizer = Nylas's 50-participant cap
      .refine((ids) => new Set(ids).size === ids.length, "Duplicate founder selected."),
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
  // The advisor joins this set rather than being handled separately, so every
  // downstream step — connection lookup, stated availability windows,
  // participant emails for Nylas, the weekly-cap check, notConnectedNames —
  // treats them like any other participant with no extra branching. An
  // advisor's calendar has to be free for the slot exactly as a guest's does.
  const allSelectedIds = [
    ...new Set([
      body.organizerMemberId,
      ...(body.advisorMemberId ? [body.advisorMemberId] : []),
      ...body.guestMemberIds,
    ]),
  ];
  const [activeConnections, selectedMembers, availabilityRows] = await Promise.all([
    getActiveConnections(allSelectedIds),
    getMembersByIds(allSelectedIds),
    getMemberAvailabilityForMembers(allSelectedIds),
  ]);
  // Grouped, not one-per-member: someone can hold a personal and a work
  // calendar, and a slot is only genuinely free if they're free in ALL of them.
  const connectionsByMemberId = groupConnectionsByMember(activeConnections);
  const isConnected = (id: number) => (connectionsByMemberId.get(id)?.length ?? 0) > 0;
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

  if (!isConnected(body.organizerMemberId)) {
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

  // Same reasoning as the isFacilitator check above: the picker only offers
  // advisors, but that's a client-side filter, not a guarantee.
  if (body.advisorMemberId && !membersById.get(body.advisorMemberId)?.isAdvisor) {
    return NextResponse.json({
      slots: [],
      checkedCount: 0,
      totalSelected: allSelectedIds.length,
      notConnectedNames: [],
      error: "The selected advisor isn't marked as an advisor.",
    });
  }

  const notConnectedNames = allSelectedIds
    .filter((id) => !isConnected(id))
    .map((id) => membersById.get(id)?.fullName ?? `Unknown member #${id}`);

  // checkedCount/totalSelected count PEOPLE, not calendars — someone with two
  // connected calendars is still one person, and reporting "checked 4 of 3
  // people" because one of them holds two accounts would be nonsense.
  const checkedCount = allSelectedIds.filter(isConnected).length;

  // Every calendar of every selected member, deduped by address. All of them
  // must be free for a slot to be offered, which is exactly the rule wanted
  // here: a member with a personal and a work calendar is only offered when
  // both are clear. Deduping also covers two members who happen to share an
  // account, which would otherwise be queried twice.
  const participantConnections = [
    ...new Map(
      allSelectedIds
        .flatMap((id) => connectionsByMemberId.get(id) ?? [])
        .map((c) => [c.grant_email, connectionCredentials(c)] as const)
    ).values(),
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
  let bookedEvents;
  try {
    [slots, bookedEvents] = await Promise.all([
      getCollectiveAvailability({
        connections: participantConnections,
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
      // Only needs to cover the visible search range itself — the grid never
      // renders cells outside [startDate, endDate] to begin with.
      getBookedEventsOverlapping(allSelectedIds, new Date(startTime * 1000), new Date(endTime * 1000)),
    ]);
  } catch (err) {
    console.error("[admin/availability] Availability lookup failed", {
      startTime,
      endTime,
      participantCount: participantConnections.length,
      error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json(
      {
        // Names the calendar that failed when we know it — an admin can then
        // chase the right person instead of retrying blindly. The error message
        // already carries the address (see AvailabilityUnavailableError).
        error:
          err instanceof Error && err.name === "AvailabilityUnavailableError"
            ? `${err.message}. They may need to reconnect it.`
            : "Couldn't check calendars right now. Please try again.",
      },
      { status: 502 }
    );
  }

  // Nylas only knows about real calendar free/busy — it has no idea a member
  // set "Mondays 2-5pm only" on /me. Every selected member (organizer, advisor
  // AND founders) must individually clear their own stated availability
  // window, checked in each member's own timezone.
  const availableSlots = slots.filter((slot) =>
    allSelectedIds.every((id) =>
      slotMatchesMemberAvailability(
        { startUnix: slot.startTime, endUnix: slot.endTime },
        membersById.get(id)?.timezone ?? null,
        availabilityByMemberId.get(id) ?? []
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
      // The id is what makes a booked cell actionable — without it the grid
      // can show a session but not cancel it.
      id: e.id,
      startUnix: Math.floor(e.startsAt.getTime() / 1000),
      endUnix: Math.floor(e.endsAt.getTime() / 1000),
      title: e.title,
      organizerMemberId: e.organizerMemberId,
      // Sent with the slot rather than fetched when the dialog opens: there
      // are only ever a handful of booked sessions overlapping one search, and
      // it saves a round trip at the exact moment an admin is deciding whether
      // to cancel or move something.
      attendees: e.attendees,
    })),
  });
}
