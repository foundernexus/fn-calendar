import { getAccessToken } from "@/lib/calendar/tokens";
import { fetchBusy, asCalendarProvider } from "@/lib/calendar";
import {
  computeCollectiveSlots,
  type AvailabilitySlot,
  type ParticipantBusy,
} from "@/lib/calendar/slots";

/** What the availability search needs to know about one connected calendar. */
export type AvailabilityConnection = {
  id: number;
  provider: string;
  grantEmail: string;
  refreshTokenEncrypted: string | null;
  accessTokenEncrypted: string | null;
  accessTokenExpiresAt: Date | null;
};

/** Thrown when a participant's calendar could not be read at all.
 *
 * Deliberately fatal to the whole search. The tempting alternative — skip the
 * calendar we couldn't reach and return the rest — quietly turns "we don't
 * know" into "they're free", and the visible result is a confidently offered
 * slot that lands on top of an existing meeting. A failed search that says so
 * is recoverable; a wrong booking is not. */
export class AvailabilityUnavailableError extends Error {
  constructor(
    readonly email: string,
    readonly cause: unknown
  ) {
    super(`Couldn't read ${email}'s calendar`);
    this.name = "AvailabilityUnavailableError";
  }
}

/** Every slot in the window where all of these calendars are free.
 *
 * Replaces Nylas's collective availability query. Same contract: pass every
 * calendar of every selected person, get back only the times when all of them
 * are clear.
 *
 * Note what this does NOT apply — each member's own stated weekly availability
 * from /me. That's filtered afterwards by the caller, exactly as it was when
 * Nylas produced these slots, because it's a preference rather than a fact
 * about a calendar. */
export async function getCollectiveAvailability(params: {
  connections: AvailabilityConnection[];
  startTime: number;
  endTime: number;
  durationMinutes: number;
  intervalMinutes?: number;
  timezone: string;
  workingHoursStart: string;
  workingHoursEnd: string;
  excludeWeekends: boolean;
}): Promise<AvailabilitySlot[]> {
  // Fetched in parallel — a search across six people with two calendars each
  // is twelve round trips, and doing them in sequence would put the grid
  // several seconds behind every click.
  const participants: ParticipantBusy[] = await Promise.all(
    params.connections.map(async (connection) => {
      try {
        const accessToken = await getAccessToken(connection);
        const busy = await fetchBusy({
          provider: asCalendarProvider(connection.provider),
          accessToken,
          email: connection.grantEmail,
          startTime: params.startTime,
          endTime: params.endTime,
        });
        return { email: connection.grantEmail, busy };
      } catch (err) {
        throw new AvailabilityUnavailableError(connection.grantEmail, err);
      }
    })
  );

  return computeCollectiveSlots({
    participants,
    startTime: params.startTime,
    endTime: params.endTime,
    durationMinutes: params.durationMinutes,
    intervalMinutes: params.intervalMinutes,
    timezone: params.timezone,
    workingHoursStart: params.workingHoursStart,
    workingHoursEnd: params.workingHoursEnd,
    excludeWeekends: params.excludeWeekends,
  });
}
