import {
  getMembersByIds,
  getMemberAvailabilityForMembers,
  getActiveConnections,
  connectionCredentials,
} from "@/db/queries";
import { getCollectiveAvailability } from "@/lib/calendar/availability";
import { getAccessToken } from "@/lib/calendar/tokens";
import { fetchBusy, asCalendarProvider } from "@/lib/calendar";
// Recurrence maths lives in one place — see the note there about walking local
// dates rather than adding seconds.
export { occurrenceTimes } from "@/lib/calendar/recurrence";
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

/** Which of these people are busy on their real calendar at this time.
 *
 * The counterpart to slotStillFree, not a replacement. That one answers yes/no
 * and is only ever asked when nobody wants to book over anybody. This one has to
 * NAME people, because booking over somebody's calendar is only safe if the
 * admin is overriding the people they were actually shown — see the route.
 *
 * `known` is the difference that matters, and it is the opposite of the
 * asymmetry documented on slotStillFree. That guard turns "we couldn't tell"
 * into "go ahead", and must, or a bad minute at Google becomes a second way a
 * legitimate booking gets refused. But nobody has asked to double-book anyone
 * there. Here they have, and an answer we could not verify must not be read as
 * consent to double-book a named person — so `known: false`, and the caller
 * refuses rather than guessing on somebody else's behalf.
 *
 * Buffers are applied, like everywhere else, so the names here agree with the
 * names the grid showed. Run-up (`leadMinutes`) is NOT — see the note on
 * getCollectiveAvailability's `includeBusy` for why erring that way is safe. */
export async function busyParticipants(params: {
  memberIds: number[];
  startUnix: number;
  endUnix: number;
  durationMinutes: number;
  timezone: string;
  context: string;
}): Promise<{ known: boolean; memberIds: number[] }> {
  const localStart = zonedDateTimeParts(params.startUnix, params.timezone);
  const localEnd = zonedDateTimeParts(params.endUnix, params.timezone);
  // A slot crossing midnight cannot be described by one day's working hours, so
  // there is no question to ask — and "no answer" is not "nobody is busy".
  if (localStart.date !== localEnd.date) return { known: false, memberIds: [] };

  try {
    const ids = [...new Set(params.memberIds)];
    const [connections, members] = await Promise.all([
      getActiveConnections(ids),
      getMembersByIds(ids),
    ]);
    const buffersByMember = new Map(
      members.map((m) => [m.id, { before: m.bufferBeforeMinutes, after: m.bufferAfterMinutes }])
    );
    // Both directions of the same map: the availability lib speaks in grant
    // addresses, the route speaks in member ids, and the whole point of this
    // function is handing the route names it can match against what it was sent.
    const memberIdByEmail = new Map<string, number>();
    const participants = [
      ...new Map(
        connections.map((c) => {
          memberIdByEmail.set(c.grant_email, c.member_id);
          return [
            c.grant_email,
            {
              ...connectionCredentials(c),
              bufferBeforeMinutes: buffersByMember.get(c.member_id)?.before ?? 0,
              bufferAfterMinutes: buffersByMember.get(c.member_id)?.after ?? 0,
            },
          ] as const;
        })
      ).values(),
    ];
    // Nobody connected is a genuine, knowable answer: there is no calendar to be
    // busy on. Distinct from the unreadable case below, which is ignorance.
    if (participants.length === 0) return { known: true, memberIds: [] };

    const { busySlots, unreadable } = await getCollectiveAvailability({
      connections: participants,
      startTime: params.startUnix,
      endTime: params.endUnix,
      durationMinutes: params.durationMinutes,
      intervalMinutes: AVAILABILITY_INTERVAL_MINUTES,
      timezone: params.timezone,
      workingHoursStart: localStart.time,
      workingHoursEnd: localEnd.time,
      excludeWeekends: false,
      includeBusy: true,
    });

    // Nothing readable means nothing known, and the caller must not double-book
    // anybody on the strength of that — the same guard as in slotStillFree, and
    // for the same reason, though it lands on the opposite answer here.
    //
    // Deliberately `>= participants.length`, not `> 0`. A search already offers
    // free slots without accounting for the calendars it couldn't read, saying
    // so loudly rather than refusing (see CollectiveAvailability). Treating that
    // same partial ignorance as fatal only on this path would make an override
    // permanently impossible for any group containing one broken connection,
    // while booking the very next cell along stayed fine.
    if (unreadable.length >= participants.length) return { known: false, memberIds: [] };

    const slot = (busySlots ?? []).find((s) => s.startTime === params.startUnix);
    const busy = new Set<number>();
    for (const email of slot?.busyEmails ?? []) {
      const memberId = memberIdByEmail.get(email);
      if (memberId !== undefined) busy.add(memberId);
    }
    return { known: true, memberIds: [...busy] };
  } catch (err) {
    console.warn(`[${params.context}] Couldn't work out who's busy`, err);
    return { known: false, memberIds: [] };
  }
}

/** How much slack before two identical-looking busy blocks count as different.
 * Providers round and re-encode times; a minute of drift is not a clash. */
const CLASH_TOLERANCE_SECONDS = 60;

/** Who is busy with something OTHER than this session, by name.
 *
 * Only for checking a session that ALREADY EXISTS — the daily look-ahead over
 * repeating dates. `slotStillFree` cannot answer this and must not be used for
 * it: once a series is booked, every one of its dates sits in every
 * participant's calendar, so "is this slot free" is permanently "no". Asked
 * that way, the daily check would raise a conflict against every date of every
 * series, and a list that is wrong every morning is a list Karin stops reading.
 *
 * What this asks instead: does anyone's busy time reach BEYOND the session's own
 * window? Somebody putting a 09:45–10:45 meeting over a 10:00–10:30 session is
 * caught, which is the shape a real clash usually has.
 *
 * The limit, stated plainly because nobody should later think this is airtight:
 * a clash occupying EXACTLY the same start and end is invisible here. Free/busy
 * reports that somebody is busy, never what with, so a block identical to our
 * own cannot be told apart from our own. Distinguishing them needs read access
 * to every participant's actual events, which is precisely the permission this
 * app gave up so founders only have to grant free/busy.
 *
 * Fails open, like every other calendar check here: a calendar we couldn't read
 * raises nothing. A false alarm costs more than a missed one, because the whole
 * value of this list is that everything on it is worth looking at. */
export async function occurrenceClashes(params: {
  memberIds: number[];
  startUnix: number;
  endUnix: number;
  context: string;
}): Promise<string[]> {
  try {
    const ids = [...new Set(params.memberIds)];
    const [connections, members] = await Promise.all([
      getActiveConnections(ids),
      getMembersByIds(ids),
    ]);
    const nameByMember = new Map(members.map((m) => [m.id, m.fullName || m.email]));

    // Deduped by address: one member holding two calendars is two reads, but
    // two members sharing an account must not be asked twice.
    const byEmail = new Map<string, (typeof connections)[number]>();
    for (const c of connections) if (!byEmail.has(c.grant_email)) byEmail.set(c.grant_email, c);

    // A window wider than the session, or a meeting that merely overhangs it
    // would come back clipped to our own edges and look identical to ours.
    const window = 2 * 3600;

    const results = await Promise.allSettled(
      [...byEmail.values()].map(async (connection) => {
        const accessToken = await getAccessToken(connectionCredentials(connection));
        const busy = await fetchBusy({
          provider: asCalendarProvider(connection.provider),
          accessToken,
          email: connection.grant_email,
          startTime: params.startUnix - window,
          endTime: params.endUnix + window,
        });

        const overlapping = busy.filter(
          (b) => b.start < params.endUnix && b.end > params.startUnix
        );
        const beyondOurs = overlapping.some(
          (b) =>
            b.start < params.startUnix - CLASH_TOLERANCE_SECONDS ||
            b.end > params.endUnix + CLASH_TOLERANCE_SECONDS
        );
        return beyondOurs ? (nameByMember.get(connection.member_id) ?? null) : null;
      })
    );

    const names = new Set<string>();
    for (const r of results) {
      // A rejected read is a calendar we couldn't see, not a clash.
      if (r.status === "fulfilled" && r.value) names.add(r.value);
    }
    return [...names];
  } catch (err) {
    console.warn(`[${params.context}] Clash check failed, reporting nothing`, err);
    return [];
  }
}

/** Every occurrence that can't be booked, as human dates.
 *
 * Runs the same two checks a single booking gets, for each date in the series,
 * and in parallel — six sequential round trips to Google would put the dialog
 * several seconds behind a tick box.
 *
 * The point of doing this up front: a repeating session is the one booking where
 * a clash is invisible at the moment you make it. The first date is on screen;
 * the fourth is four months away, and finding out then means an apology. */
export async function unbookableOccurrences(params: {
  memberIds: number[];
  occurrences: { startUnix: number; endUnix: number }[];
  durationMinutes: number;
  timezone: string;
}): Promise<string[]> {
  const results = await Promise.all(
    params.occurrences.map(async (o) => {
      const [outsideHours, free] = await Promise.all([
        participantsOutsideStatedHours({
          memberIds: params.memberIds,
          startUnix: o.startUnix,
          endUnix: o.endUnix,
        }),
        slotStillFree({
          memberIds: params.memberIds,
          startUnix: o.startUnix,
          endUnix: o.endUnix,
          durationMinutes: params.durationMinutes,
          timezone: params.timezone,
          context: "admin/events:recurring",
        }),
      ]);
      if (outsideHours.length === 0 && free) return null;
      const { date } = zonedDateTimeParts(o.startUnix, params.timezone);
      return outsideHours.length > 0 ? `${date} (${outsideHours.join(", ")})` : date;
    })
  );
  return results.filter((r): r is string => r !== null);
}
