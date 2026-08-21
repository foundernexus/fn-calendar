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
 * No longer thrown from getCollectiveAvailability itself — kept because the
 * callers still construct it to describe a single named failure, and its
 * message is the copy an admin reads. See `unreadable` below for what replaced
 * the throw and why the original reasoning still holds. */
export class AvailabilityUnavailableError extends Error {
  constructor(
    readonly email: string,
    readonly cause: unknown
  ) {
    super(`Couldn't read ${email}'s calendar`);
    this.name = "AvailabilityUnavailableError";
  }
}

/** Slots, plus the addresses we could not read.
 *
 * This used to throw and abandon the whole search, on the reasoning that
 * skipping an unreadable calendar "quietly turns 'we don't know' into 'they're
 * free'". That reasoning is right, and the word carrying it is *quietly* — the
 * danger was never the skipping, it was doing it without saying so.
 *
 * What made the throw untenable is scale. One participant with a withheld
 * permission took down a search across five people on 2026-08-21, and as more
 * members connect, the chance that every calendar in a given search is healthy
 * falls away. A tool that refuses to answer whenever anyone's connection is
 * imperfect stops being usable at exactly the point it starts being used.
 *
 * So: skip, and hand the names back so the caller can put them in front of the
 * admin. The caller is responsible for displaying them — a caller that drops
 * this field silently recreates the bug the old comment warned about. */
export type CollectiveAvailability = {
  slots: AvailabilitySlot[];
  /** grant_email of every calendar that could not be read. */
  unreadable: string[];
};

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
}): Promise<CollectiveAvailability> {
  // Fetched in parallel — a search across six people with two calendars each
  // is twelve round trips, and doing them in sequence would put the grid
  // several seconds behind every click.
  //
  // allSettled, not all: one rejection used to abandon the other eleven.
  const settled = await Promise.allSettled(
    params.connections.map(async (connection) => {
      const accessToken = await getAccessToken(connection);
      const busy = await fetchBusy({
        provider: asCalendarProvider(connection.provider),
        accessToken,
        email: connection.grantEmail,
        startTime: params.startTime,
        endTime: params.endTime,
      });
      return { email: connection.grantEmail, busy };
    })
  );

  const participants: ParticipantBusy[] = [];
  const unreadable: string[] = [];
  settled.forEach((result, i) => {
    if (result.status === "fulfilled") {
      participants.push(result.value);
      return;
    }
    const email = params.connections[i].grantEmail;
    unreadable.push(email);
    // Logged per calendar, with the provider's own body on `cause`, because
    // this is now the only place a single failure is visible at all — the
    // request itself will succeed.
    const cause = result.reason instanceof Error ? result.reason.message : String(result.reason);
    console.warn(`[availability] couldn't read ${email}'s calendar: ${cause}`);
  });

  return {
    slots: computeCollectiveSlots({
      participants,
      startTime: params.startTime,
      endTime: params.endTime,
      durationMinutes: params.durationMinutes,
      intervalMinutes: params.intervalMinutes,
      timezone: params.timezone,
      workingHoursStart: params.workingHoursStart,
      workingHoursEnd: params.workingHoursEnd,
      excludeWeekends: params.excludeWeekends,
    }),
    unreadable,
  };
}
