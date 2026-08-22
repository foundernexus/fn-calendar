import {
  getMembersByIds,
  getMemberAvailabilityForMembers,
  getActiveConnections,
  connectionCredentials,
} from "@/db/queries";
import { getCollectiveAvailability } from "@/lib/calendar/availability";
import {
  slotMatchesMemberAvailability,
  zonedDateTimeParts,
  AVAILABILITY_INTERVAL_MINUTES,
  type AvailabilityWindow,
} from "@/lib/time";

/** The two checks that stand between a chosen time and a real invitation.
 *
 * Shared by booking and rescheduling on purpose. They were separate before, and
 * the difference was not a decision — rescheduling simply had neither, so a
 * session could be moved onto a time a participant had blocked, or onto one
 * somebody had taken since the grid was drawn. Two copies of a guard is how the
 * copies stop agreeing, which is exactly what happened here. */

/** Anyone being booked outside the weekly hours they set for themselves,
 * by name.
 *
 * Empty means everyone is inside their stated hours — including everyone who
 * never stated any, who is treated as unconstrained rather than unavailable.
 *
 * The caller must treat a non-empty result as fatal. This reads rows we own and
 * does arithmetic on them: there is no third party to be unavailable and
 * nothing to degrade gracefully around, so "we could not tell" is not a state
 * this can be in. Someone who wrote down that they cannot make Wednesdays has
 * given a direct answer, and booking them anyway because a check was
 * inconvenient is the tool overruling its own users. */
export async function participantsOutsideStatedHours(params: {
  memberIds: number[];
  startUnix: number;
  endUnix: number;
}): Promise<string[]> {
  const ids = [...new Set(params.memberIds)];
  if (ids.length === 0) return [];

  const [members, availability] = await Promise.all([
    getMembersByIds(ids),
    getMemberAvailabilityForMembers(ids),
  ]);

  const windowsByMember = new Map<number, AvailabilityWindow[]>();
  for (const row of availability) {
    const list = windowsByMember.get(row.memberId) ?? [];
    list.push({ dayOfWeek: row.dayOfWeek, startTime: row.startTime, endTime: row.endTime });
    windowsByMember.set(row.memberId, list);
  }

  return members
    .filter(
      (m) =>
        !slotMatchesMemberAvailability(
          { startUnix: params.startUnix, endUnix: params.endUnix },
          m.timezone ?? null,
          windowsByMember.get(m.id) ?? []
        )
    )
    .map((m) => m.fullName);
}

/** Whether the slot is still clear on everyone's actual calendars.
 *
 * Fails OPEN, unlike the check above, and the asymmetry is the point. This one
 * asks Google and Microsoft over the network: a provider having a bad minute,
 * or a slot that straddles local midnight (where a single day's open-hours
 * window cannot express it), must not become a second way a legitimate booking
 * gets refused. It exists to catch a race — a grid left open, two admins at
 * once — not to be an authority.
 *
 * Returns true when the slot is free OR when we could not establish that it
 * isn't. */
export async function slotStillFree(params: {
  memberIds: number[];
  startUnix: number;
  endUnix: number;
  durationMinutes: number;
  timezone: string;
  context: string;
}): Promise<boolean> {
  const localStart = zonedDateTimeParts(params.startUnix, params.timezone);
  const localEnd = zonedDateTimeParts(params.endUnix, params.timezone);
  // A slot crossing midnight cannot be described by one day's working hours.
  if (localStart.date !== localEnd.date) return true;

  try {
    const ids = [...new Set(params.memberIds)];
    const [connections, members] = await Promise.all([
      getActiveConnections(ids),
      // Buffers again, so a slot refused by the grid can't be reached by
      // booking it directly. Without this the quiet time would be a display
      // rule at search and nothing at all at write.
      getMembersByIds(ids),
    ]);
    const buffersByMember = new Map(
      members.map((m) => [m.id, { before: m.bufferBeforeMinutes, after: m.bufferAfterMinutes }])
    );
    // Deduped by address: two members sharing an account would otherwise be
    // queried twice, and one member's two calendars must both be clear.
    const participants = [
      ...new Map(
        connections.map(
          (c) =>
            [
              c.grant_email,
              {
                ...connectionCredentials(c),
                bufferBeforeMinutes: buffersByMember.get(c.member_id)?.before ?? 0,
                bufferAfterMinutes: buffersByMember.get(c.member_id)?.after ?? 0,
              },
            ] as const
        )
      ).values(),
    ];
    if (participants.length === 0) return true;

    const { slots, unreadable } = await getCollectiveAvailability({
      connections: participants,
      startTime: params.startUnix,
      endTime: params.endUnix,
      durationMinutes: params.durationMinutes,
      intervalMinutes: AVAILABILITY_INTERVAL_MINUTES,
      timezone: params.timezone,
      // Open hours spanning exactly this slot, so only real calendar busy time
      // can rule it out. Stated hours are handled by the check above, which is
      // allowed to refuse; this one only knows about meetings.
      workingHoursStart: localStart.time,
      workingHoursEnd: localEnd.time,
      excludeWeekends: false,
    });

    // Nothing readable means nothing known, and nothing known must not read as
    // "busy". This needs saying because it used to happen by accident: an
    // unreadable calendar THREW, and the catch below turned it into a pass.
    // Once those failures became a reported list instead of an exception, the
    // call started succeeding with zero readable participants and zero slots —
    // which computes as "no free time" and would have refused the booking. The
    // guard would have flipped from fail-open to fail-closed silently, and only
    // for the people whose calendars were already broken.
    if (unreadable.length >= participants.length) return true;

    return slots.some((s) => s.startTime === params.startUnix);
  } catch (err) {
    console.warn(`[${params.context}] Slot re-check failed, proceeding anyway`, err);
    return true;
  }
}
