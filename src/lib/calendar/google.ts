import { env } from "@/lib/env";
import type { BusyInterval, OwnEvent } from "@/lib/calendar/slots";
import { requestedScopes, type CalendarAccess } from "@/lib/calendar/scopes";

/** Google Calendar, spoken to directly.
 *
 * Replaces the Google half of what Nylas did. Everything here is plain OAuth 2
 * and REST — there is no SDK, because the four calls we need are smaller than
 * the wrapper would be.
 *
 * Scopes now come from lib/calendar/scopes.ts and differ by role. They used to
 * be one list here, copied from the Nylas connector, and the note in its place
 * said narrowing to calendar.freebusy would stop us enumerating a member's
 * secondary calendars. That was true of freebusy alone and missed that
 * calendar.calendarlist.readonly exists and closes exactly that gap — so the
 * reason for asking everyone for "see and download any calendar" turned out not
 * to hold. See scopes.ts for what replaced it and why. */

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const CALENDAR_API = "https://www.googleapis.com/calendar/v3";

export function googleRedirectUri() {
  return `${env.APP_URL}/api/auth/google/callback`;
}

/** Where to send someone to connect their Google calendar.
 *
 * `access_type=offline` plus `prompt=consent` is what actually returns a
 * refresh token. Google only issues one on the FIRST authorisation for a given
 * user/client pair; without prompt=consent, anyone reconnecting gets an access
 * token good for an hour and nothing to renew it with, and their calendar
 * silently stops being readable that afternoon. Asking every time costs one
 * extra screen and removes a whole class of "it worked yesterday". */
export function buildGoogleAuthUrl(params: {
  state: string;
  loginHint?: string;
  access: CalendarAccess;
}) {
  const url = new URL(AUTH_URL);
  url.searchParams.set("client_id", env.GOOGLE_CLIENT_ID);
  url.searchParams.set("redirect_uri", googleRedirectUri());
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", requestedScopes("google", params.access).join(" "));
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  // Deliberately NOT include_granted_scopes=true.
  //
  // That flag is incremental authorisation: the returned token also covers
  // every scope this account ever granted the app. Harmless while the scope
  // list only ever grew, and directly contrary to the point once it shrank —
  // everyone who connected before the narrowing granted calendar.readonly, and
  // with this on they would keep it forever no matter how little we asked for.
  // The consent screen would show two modest lines while the token quietly
  // carried the broad read they thought they were leaving behind.
  //
  // It also made the capability check unfalsifiable: someone who unticks a
  // permission still gets a token carrying it from the earlier grant, so a
  // withheld permission would pass the check and look fine.
  //
  // Note this does not shrink a grant that already exists — Google keeps the
  // old consent on file. Clearing that is the account owner's to do, at
  // myaccount.google.com/permissions.
  url.searchParams.set("state", params.state);
  if (params.loginHint) url.searchParams.set("login_hint", params.loginHint);
  return url.toString();
}

/** Wraps a non-2xx provider response with its body attached.
 *
 * The body is the entire point: Google's errors say `invalid_grant` or
 * `insufficientPermissions`, and the status code alone says none of it. A bare
 * `catch {}` over this call is what turned yesterday's outage into a morning of
 * guessing. */
export class GoogleApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    context: string
  ) {
    super(`Google ${context} failed (${status}): ${body.slice(0, 500)}`);
    this.name = "GoogleApiError";
  }
}

async function googleFetch(url: string, init: RequestInit, context: string) {
  const res = await fetch(url, init);
  if (!res.ok) {
    throw new GoogleApiError(res.status, await res.text().catch(() => ""), context);
  }
  return res;
}

export type GoogleTokens = {
  accessToken: string;
  /** Absent when Google decides this isn't a first authorisation. Callers must
   * treat that as a failure to connect rather than storing a session that dies
   * in an hour. */
  refreshToken?: string;
  expiresAt: Date;
  email: string;
  /** What Google actually granted, which is not always what we asked for — the
   * consent screen lets people untick individual permissions. Empty if Google
   * didn't report it; see missingCapabilities for why that isn't treated as a
   * refusal. */
  grantedScopes: string[];
};

export async function exchangeGoogleCode(code: string): Promise<GoogleTokens> {
  const res = await googleFetch(
    TOKEN_URL,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: env.GOOGLE_CLIENT_ID,
        client_secret: env.GOOGLE_CLIENT_SECRET,
        redirect_uri: googleRedirectUri(),
        grant_type: "authorization_code",
      }),
    },
    "code exchange"
  );
  const data = (await res.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
    id_token?: string;
    scope?: string;
  };

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: new Date(Date.now() + data.expires_in * 1000),
    email: await fetchGoogleEmail(data.access_token),
    grantedScopes: data.scope?.split(" ").filter(Boolean) ?? [],
  };
}

/** Whose calendar this is. Read from the userinfo endpoint rather than by
 * decoding the id_token: the value decides which member a calendar is bound to,
 * and a JWT we haven't verified is not something to make that decision on. */
async function fetchGoogleEmail(accessToken: string) {
  const res = await googleFetch(
    "https://www.googleapis.com/oauth2/v2/userinfo",
    { headers: { Authorization: `Bearer ${accessToken}` } },
    "userinfo"
  );
  const data = (await res.json()) as { email?: string };
  if (!data.email) throw new Error("Google returned no email for this account");
  return data.email;
}

export async function refreshGoogleToken(refreshToken: string) {
  const res = await googleFetch(
    TOKEN_URL,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        refresh_token: refreshToken,
        client_id: env.GOOGLE_CLIENT_ID,
        client_secret: env.GOOGLE_CLIENT_SECRET,
        grant_type: "refresh_token",
      }),
    },
    "token refresh"
  );
  const data = (await res.json()) as { access_token: string; expires_in: number };
  return {
    accessToken: data.access_token,
    expiresAt: new Date(Date.now() + data.expires_in * 1000),
  };
}

/** Busy periods across every calendar this token can reach.
 *
 * Two calls, not one: freeBusy only reports on calendars you name, so the
 * calendar list is fetched first where we are allowed to. Where we are not, that
 * is one calendar — `primary` — and the difference is invisible from here.
 *
 * Google caps a freeBusy query at 50 calendars, so the list is chunked. */
export async function fetchGoogleBusy(params: {
  accessToken: string;
  startTime: number;
  endTime: number;
}): Promise<BusyInterval[]> {
  const calendarIds = await listGoogleCalendarIds(params.accessToken);

  const busy: BusyInterval[] = [];
  let readCount = 0;
  const failed: string[] = [];

  for (let i = 0; i < calendarIds.length; i += 50) {
    const chunk = calendarIds.slice(i, i + 50);
    const res = await googleFetch(
      `${CALENDAR_API}/freeBusy`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${params.accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          timeMin: new Date(params.startTime * 1000).toISOString(),
          timeMax: new Date(params.endTime * 1000).toISOString(),
          items: chunk.map((id) => ({ id })),
        }),
      },
      "freeBusy"
    );
    const data = (await res.json()) as {
      calendars: Record<string, { busy?: { start: string; end: string }[]; errors?: unknown[] }>;
    };

    for (const [id, entry] of Object.entries(data.calendars ?? {})) {
      // A per-calendar error (access revoked, calendar deleted, a subscription
      // whose owner withdrew it) is reported INSIDE a 200 response, with `busy`
      // simply absent. Reading only `busy` therefore turned a calendar we could
      // not see into a calendar with nothing on it, which is the one mistake a
      // scheduling tool must not make: it offers a slot it cannot vouch for.
      if (entry.errors?.length) {
        failed.push(id);
        continue;
      }
      readCount += 1;
      for (const block of entry.busy ?? []) {
        busy.push({
          start: Math.floor(Date.parse(block.start) / 1000),
          end: Math.floor(Date.parse(block.end) / 1000),
        });
      }
    }
  }

  if (failed.length > 0) {
    console.warn(
      `[google] freeBusy could not read ${failed.length} calendar(s): ${failed.join(", ")}`
    );
  }
  // Nothing readable at all means we know nothing about this person, which is
  // not the same as them being free. Fail loudly so the grid marks the
  // connection broken instead of showing a wide-open week.
  if (readCount === 0) {
    throw new Error(
      `Google returned no readable calendars (asked for ${calendarIds.length}, all failed)`
    );
  }
  return busy;
}

/** The calendars to ask freeBusy about.
 *
 * Founders and advisors are no longer asked for calendar.calendarlist.readonly,
 * so this 403s for them and `primary` is the answer — see the note in
 * scopes.ts for what that trades away. The failure is caught rather than
 * predicted from the granted scopes because the two can disagree: someone who
 * connected before the narrowing still holds the broader grant and should keep
 * the wider read, and a scope can be revoked at myaccount.google.com without
 * anything here being told. Asking the API is the only account that stays true.
 *
 * Deliberately not filtered by `selected`: that flag is whether the calendar is
 * ticked in Google's own sidebar, which is a display preference. A calendar
 * hidden from view still holds appointments that make the person unavailable. */
async function listGoogleCalendarIds(accessToken: string) {
  try {
    const res = await googleFetch(
      `${CALENDAR_API}/users/me/calendarList?minAccessRole=freeBusyReader&maxResults=250`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
      "calendarList"
    );
    const data = (await res.json()) as { items?: { id: string }[] };
    const ids = (data.items ?? []).map((c) => c.id);
    return ids.length > 0 ? ids : ["primary"];
  } catch (err) {
    console.info(
      "[google] calendar list unavailable, reading primary only:",
      err instanceof Error ? err.message : err
    );
    return ["primary"];
  }
}

export async function createGoogleEvent(params: {
  accessToken: string;
  title: string;
  description?: string;
  meetingUrl?: string;
  startTime: number;
  endTime: number;
  timezone: string;
  participants: { name?: string; email: string }[];
  /** Whose calendar this is being created on. */
  organizerEmail?: string;
  /** RFC 5545 rule for a repeating session, e.g.
   * `RRULE:FREQ=WEEKLY;INTERVAL=4;COUNT=6`. Absent for a one-off. */
  recurrenceRule?: string;
  /** Enables asking Google for a Meet link when no `meetingUrl` was pasted.
   *
   * Google deduplicates conference creation on this id, so it has to survive a
   * retry unchanged — a fresh value on the second attempt would hand the same
   * session two different Meet rooms. The booking's idempotency key is already
   * exactly that: stable for one booking, different for every other. Absent
   * means "don't create one", which is what the reschedule and cancel paths
   * want. */
  conferenceRequestId?: string;
}) {
  const organizer = params.organizerEmail?.trim().toLowerCase();
  // A pasted link wins. Someone who keeps a standing Zoom room on /me is
  // naming the room this session happens in, and quietly creating a second,
  // different place for the same meeting would be worse than useless. An empty
  // field is what asks for a Meet link — no extra switch to forget.
  const createConference = !params.meetingUrl?.trim() && !!params.conferenceRequestId;
  const res = await googleFetch(
    // sendUpdates=all is what actually emails the invitations. Without it the
    // event appears on the organiser's calendar and nobody else ever hears
    // about it.
    //
    // conferenceDataVersion=1 is what makes Google read conferenceData at all;
    // at 0 it ignores the field entirely and silently creates a link-less
    // event.
    `${CALENDAR_API}/calendars/primary/events?sendUpdates=all&conferenceDataVersion=1`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${params.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        summary: params.title,
        description: params.description,
        // An admin-pasted URL of unknown provider goes in `location`, not a
        // typed conferencing object — it shows on the invite whatever it is.
        location: params.meetingUrl,
        ...(createConference
          ? {
              conferenceData: {
                createRequest: {
                  requestId: params.conferenceRequestId,
                  conferenceSolutionKey: { type: "hangoutsMeet" },
                },
              },
            }
          : {}),
        // A repeating session is ONE event carrying a rule, not many events.
        // The people on it get a single invitation, and their calendar handles
        // skipping or moving an individual occurrence — which it does well, in
        // the app they already have open.
        ...(params.recurrenceRule ? { recurrence: [params.recurrenceRule] } : {}),
        start: { dateTime: new Date(params.startTime * 1000).toISOString(), timeZone: params.timezone },
        end: { dateTime: new Date(params.endTime * 1000).toISOString(), timeZone: params.timezone },
        // The session lead is listed like everyone else — they're leading it,
        // not merely implied by owning the calendar — but they are marked as
        // already accepted.
        //
        // Without responseStatus Google defaults every attendee to
        // "needsAction", including the person the event was just created FOR.
        // The result: a session lead looking at their own calendar sees an
        // invitation they appear not to have answered, for a meeting they are
        // hosting, that they will never be emailed about because Google does
        // not invite an organiser to their own event. Nothing was broken, but
        // it read as broken, which for a scheduling tool is close enough.
        attendees: params.participants.map((p) => ({
          email: p.email,
          displayName: p.name,
          ...(organizer && p.email.trim().toLowerCase() === organizer
            ? { responseStatus: "accepted" as const }
            : {}),
        })),
      }),
    },
    "event create"
  );
  const data = (await res.json()) as {
    id: string;
    htmlLink?: string;
    hangoutLink?: string;
    conferenceData?: { entryPoints?: { entryPointType?: string; uri?: string }[] };
  };
  // Both spellings, because Google gives the video entry point on
  // conferenceData and ALSO mirrors a Meet room to the older top-level
  // hangoutLink. Reading only one of them works right up until it doesn't.
  //
  // Creation is documented as asynchronous, so a `pending` conference can come
  // back with no link yet. Deliberately not retried or re-fetched: the event is
  // already real and Google shows attendees the Meet link on the invite either
  // way, so the only cost is our own copy being blank on the advisor dashboard
  // — not worth a second round trip and the latency it adds to every booking.
  const meetingUrl =
    data.conferenceData?.entryPoints?.find((e) => e.entryPointType === "video")?.uri ??
    data.hangoutLink;
  return { eventId: data.id, url: data.htmlLink, meetingUrl };
}

export async function updateGoogleEvent(params: {
  accessToken: string;
  eventId: string;
  startTime: number;
  endTime: number;
  timezone: string;
}) {
  // PATCH, not a delete-and-recreate: attendees get a "this moved" update
  // rather than a cancellation followed by a fresh invite, so it stays one
  // entry in their calendar and keeps whatever they had already answered.
  await googleFetch(
    `${CALENDAR_API}/calendars/primary/events/${encodeURIComponent(params.eventId)}?sendUpdates=all`,
    {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${params.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        start: { dateTime: new Date(params.startTime * 1000).toISOString(), timeZone: params.timezone },
        end: { dateTime: new Date(params.endTime * 1000).toISOString(), timeZone: params.timezone },
      }),
    },
    "event update"
  );
}

/** Google's own id for ONE date of a repeating event.
 *
 * A series is a single event to us and to Google, but each of its dates has its
 * own id the moment you ask for it — and that id is what both the update and
 * the delete endpoints accept in place of the series id. So moving one date
 * needs no new write path, only this lookup.
 *
 * Matched on `originalStartTime`, never on the instance's current start: an
 * occurrence that has already been moved sits somewhere else entirely, and the
 * original start is the only value that stays put. The window is generous for
 * the same reason.
 *
 * Returns null when the date isn't in the series — a rule that changed under
 * us, or a date already deleted in Google. The caller has to treat that as
 * "nothing to move" rather than retrying. */
export async function findGoogleInstanceId(params: {
  accessToken: string;
  seriesEventId: string;
  originalStartUnix: number;
}): Promise<string | null> {
  const window = 7 * 86_400;
  const url = new URL(
    `${CALENDAR_API}/calendars/primary/events/${encodeURIComponent(params.seriesEventId)}/instances`
  );
  url.searchParams.set("timeMin", new Date((params.originalStartUnix - window) * 1000).toISOString());
  url.searchParams.set("timeMax", new Date((params.originalStartUnix + window) * 1000).toISOString());
  url.searchParams.set("maxResults", "50");

  const res = await googleFetch(
    url.toString(),
    { headers: { Authorization: `Bearer ${params.accessToken}` } },
    "event instances"
  );
  const data = (await res.json()) as {
    items?: {
      id: string;
      originalStartTime?: { dateTime?: string; date?: string };
    }[];
  };

  for (const item of data.items ?? []) {
    const original = item.originalStartTime?.dateTime ?? item.originalStartTime?.date;
    if (!original) continue;
    if (Math.floor(Date.parse(original) / 1000) === params.originalStartUnix) return item.id;
  }
  return null;
}

export async function deleteGoogleEvent(params: { accessToken: string; eventId: string }) {
  const res = await fetch(
    `${CALENDAR_API}/calendars/primary/events/${encodeURIComponent(params.eventId)}?sendUpdates=all`,
    { method: "DELETE", headers: { Authorization: `Bearer ${params.accessToken}` } }
  );
  // Already gone (410) or never there (404) is the state we wanted. Treating
  // those as failures would leave the admin unable to clear a session from the
  // grid because it had been deleted in Google first.
  if (!res.ok && res.status !== 404 && res.status !== 410) {
    throw new GoogleApiError(res.status, await res.text().catch(() => ""), "event delete");
  }
}

/** Hands the refresh token back to Google, which invalidates it and drops the
 * app from the member's account permissions page. Marking our row revoked
 * without this leaves the grant alive on Google's side — the member sees an app
 * they think they removed still holding access. */
export async function revokeGoogleToken(refreshToken: string) {
  const res = await fetch(REVOKE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token: refreshToken }),
  });
  // 400 means Google no longer recognises it — already revoked or expired,
  // which is the outcome we were after.
  if (!res.ok && res.status !== 400) {
    throw new GoogleApiError(res.status, await res.text().catch(() => ""), "token revoke");
  }
}

/** What the signed-in person actually has on, titles included.
 *
 * Deliberately separate from fetchGoogleBusy, and used for one thing only: so
 * whoever is booking can see their OWN day while they pick a slot. "10:00 is
 * free" and "10:00 is free but you're with Court at 10:30" lead to different
 * decisions, and until now the second was a trip to another tab.
 *
 * Never called for anyone but the person looking at the screen. Reading a
 * participant's event titles would be a different product with a different
 * consent screen — free/busy is all we ask of them and all we take.
 *
 * Needs calendar.events, which session leads already grant so their sessions
 * can be created. No new permission, and no reason to ask a founder for one. */
export async function fetchGoogleOwnEvents(params: {
  accessToken: string;
  startTime: number;
  endTime: number;
}): Promise<OwnEvent[]> {
  const url = new URL(`${CALENDAR_API}/calendars/primary/events`);
  url.searchParams.set("timeMin", new Date(params.startTime * 1000).toISOString());
  url.searchParams.set("timeMax", new Date(params.endTime * 1000).toISOString());
  // Expands a recurring series into its instances — without it a weekly 1:1
  // comes back as one master event and shows up on the wrong day, or no day.
  url.searchParams.set("singleEvents", "true");
  url.searchParams.set("orderBy", "startTime");
  url.searchParams.set("maxResults", "250");

  const res = await googleFetch(
    url.toString(),
    { headers: { Authorization: `Bearer ${params.accessToken}` } },
    "own events"
  );
  const data = (await res.json()) as {
    items?: {
      summary?: string;
      status?: string;
      start?: { dateTime?: string; date?: string };
      end?: { dateTime?: string; date?: string };
    }[];
  };

  const events: OwnEvent[] = [];
  for (const item of data.items ?? []) {
    if (item.status === "cancelled") continue;
    // An all-day event carries `date` instead of `dateTime`. Google marks these
    // free by default, which is why they never appear in free/busy — the whole
    // reason a blocked-out day could still read as available.
    const allDay = !!item.start?.date;
    const startRaw = item.start?.dateTime ?? item.start?.date;
    const endRaw = item.end?.dateTime ?? item.end?.date;
    if (!startRaw || !endRaw) continue;
    const start = Math.floor(Date.parse(startRaw) / 1000);
    const end = Math.floor(Date.parse(endRaw) / 1000);
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    events.push({
      start,
      end,
      // Google omits `summary` on events with no title. "Busy" is what its own
      // interface shows in that case.
      title: item.summary?.trim() || "Busy",
      allDay,
    });
  }
  return events;
}
