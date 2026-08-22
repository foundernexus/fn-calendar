import {
  buildGoogleAuthUrl,
  exchangeGoogleCode,
  fetchGoogleBusy,
  createGoogleEvent,
  updateGoogleEvent,
  deleteGoogleEvent,
  revokeGoogleToken,
  fetchGoogleOwnEvents,
} from "@/lib/calendar/google";
import {
  buildMicrosoftAuthUrl,
  exchangeMicrosoftCode,
  fetchMicrosoftBusy,
  createMicrosoftEvent,
  updateMicrosoftEvent,
  deleteMicrosoftEvent,
  revokeMicrosoftToken,
  fetchMicrosoftOwnEvents,
} from "@/lib/calendar/microsoft";
import type { BusyInterval, OwnEvent } from "@/lib/calendar/slots";
import type { CalendarAccess } from "@/lib/calendar/scopes";

/** One shape for both providers, so nothing outside this folder has to know
 * which one a member uses. Mirrors what src/lib/nylas.ts exposed, which is why
 * the routes barely change when they switch over. */

export const CALENDAR_PROVIDERS = ["google", "microsoft"] as const;
export type CalendarProvider = (typeof CALENDAR_PROVIDERS)[number];

/** Anything that isn't recognised is treated as Google.
 *
 * Kept identical to the old asCalendarProvider: `provider` is a free-text
 * column, and defaulting is better than throwing on a row written by an older
 * version of this code. */
export function asCalendarProvider(value: string | null | undefined): CalendarProvider {
  return value === "microsoft" ? "microsoft" : "google";
}

/** `access` decides how much the consent screen asks for — "read" for founders
 * and advisors, "write" for the session leads and admins whose own calendar a
 * session is actually created on. See lib/calendar/scopes.ts. */
export function buildAuthUrl(params: {
  provider: CalendarProvider;
  state: string;
  loginHint?: string;
  access: CalendarAccess;
}) {
  return params.provider === "microsoft"
    ? buildMicrosoftAuthUrl(params)
    : buildGoogleAuthUrl(params);
}

export type ExchangedTokens = {
  accessToken: string;
  refreshToken?: string;
  expiresAt: Date;
  email: string;
  provider: CalendarProvider;
  grantedScopes: string[];
};

export async function exchangeCode(
  provider: CalendarProvider,
  code: string
): Promise<ExchangedTokens> {
  const tokens =
    provider === "microsoft" ? await exchangeMicrosoftCode(code) : await exchangeGoogleCode(code);
  return { ...tokens, provider };
}

/** Busy periods for one connected calendar account.
 *
 * Note the asymmetry: Google needs no address because the token identifies the
 * account and we walk its calendar list, while Microsoft's getSchedule is asked
 * about a specific mailbox. Both end up meaning "everything this account can
 * see". */
export async function fetchBusy(params: {
  provider: CalendarProvider;
  accessToken: string;
  email: string;
  startTime: number;
  endTime: number;
}): Promise<BusyInterval[]> {
  return params.provider === "microsoft"
    ? fetchMicrosoftBusy(params)
    : fetchGoogleBusy(params);
}

export async function createEvent(params: {
  provider: CalendarProvider;
  accessToken: string;
  title: string;
  description?: string;
  meetingUrl?: string;
  startTime: number;
  endTime: number;
  timezone: string;
  participants: { name?: string; email: string }[];
  /** Whose calendar the event lands on. Google uses it to mark that person as
   * already accepted; Microsoft ignores it, because Graph derives the organiser
   * from the mailbox being written to and the behaviour there is untested. */
  organizerEmail?: string;
  /** RFC 5545 rule for a repeating session. Google only — see
   * createMicrosoftEvent. */
  recurrenceRule?: string;
}) {
  return params.provider === "microsoft"
    ? createMicrosoftEvent(params)
    : createGoogleEvent(params);
}

export async function updateEvent(params: {
  provider: CalendarProvider;
  accessToken: string;
  eventId: string;
  startTime: number;
  endTime: number;
  timezone: string;
}) {
  return params.provider === "microsoft"
    ? updateMicrosoftEvent(params)
    : updateGoogleEvent(params);
}

export async function deleteEvent(params: {
  provider: CalendarProvider;
  accessToken: string;
  eventId: string;
}) {
  return params.provider === "microsoft"
    ? deleteMicrosoftEvent(params)
    : deleteGoogleEvent(params);
}

/** Hands the token back to the provider where that's possible.
 *
 * Google revokes properly. Microsoft has no per-token revocation — see the note
 * in microsoft.ts — so it reports `revokedAtProvider: false` and the caller is
 * expected to tell the member the truth rather than claim a revocation that
 * didn't happen. */
export async function revokeToken(params: {
  provider: CalendarProvider;
  refreshToken: string;
}): Promise<{ revokedAtProvider: boolean }> {
  if (params.provider === "microsoft") {
    return revokeMicrosoftToken(params.refreshToken);
  }
  await revokeGoogleToken(params.refreshToken);
  return { revokedAtProvider: true };
}

export type { OwnEvent };

/** The signed-in person's own day, so they can see what a free slot sits next
 * to before they book into it. */
export async function fetchOwnEvents(params: {
  provider: CalendarProvider;
  accessToken: string;
  startTime: number;
  endTime: number;
}): Promise<OwnEvent[]> {
  return params.provider === "microsoft"
    ? fetchMicrosoftOwnEvents(params)
    : fetchGoogleOwnEvents(params);
}
