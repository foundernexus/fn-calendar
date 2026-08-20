import { env } from "@/lib/env";
import type { BusyInterval } from "@/lib/calendar/slots";
import { requestedScopes, type CalendarAccess } from "@/lib/calendar/scopes";

/** Microsoft Outlook / Microsoft 365, spoken to directly through Graph.
 *
 * Same shape as the Google module, different vocabulary. Scopes come from
 * lib/calendar/scopes.ts and differ by role — everyone used to get
 * Calendars.ReadWrite, which is read AND write across every calendar in the
 * mailbox, when all most people need is free/busy. */

const GRAPH = "https://graph.microsoft.com/v1.0";

function authority() {
  return `https://login.microsoftonline.com/${env.MICROSOFT_TENANT}`;
}

export function microsoftRedirectUri() {
  return `${env.APP_URL}/api/auth/microsoft/callback`;
}

export function buildMicrosoftAuthUrl(params: {
  state: string;
  loginHint?: string;
  access: CalendarAccess;
}) {
  const url = new URL(`${authority()}/oauth2/v2.0/authorize`);
  url.searchParams.set("client_id", env.MICROSOFT_CLIENT_ID);
  url.searchParams.set("redirect_uri", microsoftRedirectUri());
  url.searchParams.set("response_type", "code");
  url.searchParams.set("response_mode", "query");
  url.searchParams.set("scope", requestedScopes("microsoft", params.access).join(" "));
  url.searchParams.set("state", params.state);
  if (params.loginHint) url.searchParams.set("login_hint", params.loginHint);
  return url.toString();
}

/** Carries the provider's own error text. Microsoft's messages are the useful
 * part — `AADSTS70000` and friends name the actual problem, and a bare status
 * code names nothing. That exact error cost a morning when it was swallowed. */
export class MicrosoftApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    context: string
  ) {
    super(`Microsoft ${context} failed (${status}): ${body.slice(0, 500)}`);
    this.name = "MicrosoftApiError";
  }
}

async function graphFetch(url: string, init: RequestInit, context: string) {
  const res = await fetch(url, init);
  if (!res.ok) {
    throw new MicrosoftApiError(res.status, await res.text().catch(() => ""), context);
  }
  return res;
}

export type MicrosoftTokens = {
  accessToken: string;
  refreshToken?: string;
  expiresAt: Date;
  email: string;
  /** What Microsoft actually granted. Empty if it didn't say — see
   * missingCapabilities for why that isn't read as a refusal. */
  grantedScopes: string[];
};

export async function exchangeMicrosoftCode(code: string): Promise<MicrosoftTokens> {
  const res = await graphFetch(
    `${authority()}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: env.MICROSOFT_CLIENT_ID,
        client_secret: env.MICROSOFT_CLIENT_SECRET,
        redirect_uri: microsoftRedirectUri(),
        grant_type: "authorization_code",
      }),
    },
    "code exchange"
  );
  const data = (await res.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
    scope?: string;
  };

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: new Date(Date.now() + data.expires_in * 1000),
    email: await fetchMicrosoftEmail(data.access_token),
    grantedScopes: data.scope?.split(" ").filter(Boolean) ?? [],
  };
}

/** Whose account this is — and the one value in this file that has to be right.
 *
 * `userPrincipalName` FIRST, deliberately. This used to read `mail` first, and
 * that is an account-takeover hole: `mail` is a mutable directory attribute
 * that any tenant administrator can set to any address, including on a domain
 * they have never proved they own. The UPN suffix, by contrast, must be a
 * verified domain of the tenant, so it cannot be pointed at somebody else's
 * company.
 *
 * Why that matters here: this address is compared against a registered
 * member's, and a match is the ONLY thing establishing that the person who
 * just finished OAuth owns the account being bound (see the identity check in
 * api/auth/[provider]/callback). With `mail` winning, anyone could stand up a
 * free tenant, type a member's address into that field, and be handed that
 * member's session — or an admin's. Google is not affected: its userinfo
 * address is the account, and the provider verifies the domain.
 *
 * Reversing the order is safe for the accounts we hold. Personal Outlook
 * accounts leave `mail` empty and carry the address in the UPN, which is what
 * the previous note here was about, so they resolve identically either way.
 *
 * `mail` is kept as a fallback rather than dropped: some directory
 * configurations leave the UPN unusable, and an account with no resolvable
 * address cannot connect at all. It is only reached when there is no UPN, so
 * it can no longer override a verified value. */
async function fetchMicrosoftEmail(accessToken: string) {
  const res = await graphFetch(
    `${GRAPH}/me?$select=mail,userPrincipalName`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
    "me"
  );
  const data = (await res.json()) as { mail?: string; userPrincipalName?: string };
  const email = data.userPrincipalName || data.mail;
  if (!email) throw new Error("Microsoft returned no email for this account");

  // A guest invited into someone else's tenant gets a UPN of the form
  // `person_theirdomain.com#EXT#@hosttenant.onmicrosoft.com`. It identifies the
  // guest relationship, not a mailbox, and binding a calendar to it would tie
  // someone's sessions to an address that can't receive an invitation.
  if (email.includes("#EXT#")) {
    throw new Error("Microsoft returned a guest account, which can't be connected");
  }

  // Divergence is legitimate in plenty of tenants (UPN on the onmicrosoft.com
  // domain, mail on the company one), and it is now the case where someone's
  // registered address may no longer match what we resolve. Logged so that
  // shows up as a line naming both rather than as an unexplained "denied".
  if (data.mail && data.userPrincipalName && data.mail !== data.userPrincipalName) {
    console.warn("[microsoft] account reports two different addresses", {
      userPrincipalName: data.userPrincipalName,
      mail: data.mail,
      using: email,
    });
  }

  return email;
}

export async function refreshMicrosoftToken(refreshToken: string) {
  const res = await graphFetch(
    `${authority()}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        refresh_token: refreshToken,
        client_id: env.MICROSOFT_CLIENT_ID,
        client_secret: env.MICROSOFT_CLIENT_SECRET,
        // Deliberately no `scope`. It is optional on a refresh, and when it is
        // omitted Microsoft reissues the token with whatever the original grant
        // carried — which is the only correct answer now that different people
        // hold different scopes.
        //
        // Naming a scope here would be wrong in both directions: sending the
        // read-only set would silently strip a session lead of write access on
        // their next refresh (a refresh may narrow, so it would succeed and
        // quietly break booking an hour later), and sending the write set would
        // be rejected outright for anyone who only granted read, since a refresh
        // can never widen. It also used to pin a constant that no longer exists.
        grant_type: "refresh_token",
      }),
    },
    "token refresh"
  );
  const data = (await res.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
  };
  return {
    accessToken: data.access_token,
    // Microsoft rotates refresh tokens: a refresh often returns a NEW one and
    // retires the old. Callers must persist this when present, or the
    // connection works until the next rotation and then stops for good.
    refreshToken: data.refresh_token,
    expiresAt: new Date(Date.now() + data.expires_in * 1000),
  };
}

/** Busy periods from the signed-in mailbox.
 *
 * getSchedule against your own address covers every calendar in the mailbox,
 * which is what we want — the equivalent of Google's calendar-list walk without
 * needing the list.
 *
 * Microsoft's reference page lists this endpoint as "Not supported" for
 * delegated personal Microsoft accounts. That is wrong, or at least out of
 * date: verified on 2026-08-20 against a personal outlook.com mailbox by
 * putting a block on the calendar by hand and confirming the availability grid
 * excluded exactly that slot. Written down because the documented position
 * looks like a reason to rip this out and reach for calendarView instead —
 * don't, without re-testing it first. Several members are on personal Outlook
 * accounts and read their free/busy through here.
 *
 * The Prefer header pins the response to UTC. Without it Graph answers in the
 * mailbox's own timezone and omits any offset, so the timestamps parse as local
 * time on the server and every busy block silently shifts by hours. */
export async function fetchMicrosoftBusy(params: {
  accessToken: string;
  email: string;
  startTime: number;
  endTime: number;
}): Promise<BusyInterval[]> {
  const res = await graphFetch(
    `${GRAPH}/me/calendar/getSchedule`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${params.accessToken}`,
        "Content-Type": "application/json",
        Prefer: 'outlook.timezone="UTC"',
      },
      body: JSON.stringify({
        schedules: [params.email],
        startTime: { dateTime: graphDateTime(params.startTime), timeZone: "UTC" },
        endTime: { dateTime: graphDateTime(params.endTime), timeZone: "UTC" },
        availabilityViewInterval: 15,
      }),
    },
    "getSchedule"
  );
  const data = (await res.json()) as {
    value?: {
      scheduleItems?: { status?: string; start: { dateTime: string }; end: { dateTime: string } }[];
    }[];
  };

  const busy: BusyInterval[] = [];
  for (const schedule of data.value ?? []) {
    for (const item of schedule.scheduleItems ?? []) {
      // Anything that isn't explicitly free counts as busy — tentative and
      // out-of-office included. Offering a slot against a tentative meeting
      // books over something the person is probably attending.
      if (item.status === "free") continue;
      busy.push({
        start: Math.floor(Date.parse(asUtc(item.start.dateTime)) / 1000),
        end: Math.floor(Date.parse(asUtc(item.end.dateTime)) / 1000),
      });
    }
  }
  return busy;
}

/** Graph wants "2026-08-19T09:00:00" with no trailing Z, and pairs it with a
 * separate timeZone field. */
function graphDateTime(unixSeconds: number) {
  return new Date(unixSeconds * 1000).toISOString().replace(/\.\d{3}Z$/, "");
}

/** Graph returns timestamps with no offset even when the response is UTC, so
 * they must be marked as UTC before parsing or the server's own timezone gets
 * applied. */
function asUtc(dateTime: string) {
  return /(?:Z|[+-]\d{2}:\d{2})$/.test(dateTime) ? dateTime : `${dateTime}Z`;
}

export async function createMicrosoftEvent(params: {
  accessToken: string;
  title: string;
  description?: string;
  meetingUrl?: string;
  startTime: number;
  endTime: number;
  timezone: string;
  participants: { name?: string; email: string }[];
}) {
  const res = await graphFetch(
    `${GRAPH}/me/events`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${params.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        subject: params.title,
        body: params.description ? { contentType: "text", content: params.description } : undefined,
        location: params.meetingUrl ? { displayName: params.meetingUrl } : undefined,
        start: { dateTime: graphDateTime(params.startTime), timeZone: "UTC" },
        end: { dateTime: graphDateTime(params.endTime), timeZone: "UTC" },
        attendees: params.participants.map((p) => ({
          emailAddress: { address: p.email, name: p.name },
          type: "required",
        })),
      }),
    },
    "event create"
  );
  const data = (await res.json()) as { id: string; webLink?: string };
  return { eventId: data.id, url: data.webLink };
}

export async function updateMicrosoftEvent(params: {
  accessToken: string;
  eventId: string;
  startTime: number;
  endTime: number;
}) {
  await graphFetch(
    `${GRAPH}/me/events/${encodeURIComponent(params.eventId)}`,
    {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${params.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        start: { dateTime: graphDateTime(params.startTime), timeZone: "UTC" },
        end: { dateTime: graphDateTime(params.endTime), timeZone: "UTC" },
      }),
    },
    "event update"
  );
}

export async function deleteMicrosoftEvent(params: { accessToken: string; eventId: string }) {
  const res = await fetch(`${GRAPH}/me/events/${encodeURIComponent(params.eventId)}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${params.accessToken}` },
  });
  // Already gone is the state we wanted — see the Google module for why this
  // must not be an error.
  if (!res.ok && res.status !== 404 && res.status !== 410) {
    throw new MicrosoftApiError(res.status, await res.text().catch(() => ""), "event delete");
  }
}

/** Microsoft has no public endpoint to revoke a single refresh token the way
 * Google does — the nearest equivalents invalidate every session the user has
 * everywhere, which is far beyond what "disconnect this calendar" should do.
 *
 * So disconnecting deletes our stored token and nothing else. The consequence
 * is worth stating plainly rather than hiding behind a no-op: the app instantly
 * loses all access, but the consent entry stays listed under the member's
 * Microsoft account until they remove it there. The disconnect copy should say
 * so instead of implying we revoked it. */
export async function revokeMicrosoftToken(_refreshToken: string) {
  return { revokedAtProvider: false as const };
}
