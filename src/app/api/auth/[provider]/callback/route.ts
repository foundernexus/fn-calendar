import { NextResponse } from "next/server";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { calendarConnections } from "@/db/schema";
import { getMemberById, getActiveConnections, pickInviteConnection } from "@/db/queries";
import {
  signValue,
  verifyValue,
  TOKEN_PURPOSE,
  MEMBER_COOKIE_NAME,
  MEMBER_SESSION_TTL_SECONDS,
} from "@/lib/auth/session";
import { hasAdminAccess, setAdminSessionCookie } from "@/lib/auth/admin";
import { exchangeCode, asCalendarProvider, CALENDAR_PROVIDERS } from "@/lib/calendar";
import { calendarAccessFor } from "@/lib/calendar/access";
import { missingCapabilities } from "@/lib/calendar/scopes";
import { encryptedTokenFields } from "@/lib/calendar/tokens";
import { normalizeEmail } from "@/lib/email";
import { env } from "@/lib/env";

/** The OAuth callback, now that we talk to Google and Microsoft ourselves.
 *
 * A direct port of api/nylas/callback: every guard below exists because of
 * something that went wrong or nearly did, so the order and the reasoning are
 * preserved deliberately rather than rewritten. The only real differences are
 * that the provider comes from the URL, and that we store encrypted tokens
 * instead of an opaque grant id. */

const FAILURE_STATUS = {
  /** State token missing or failed HMAC/TTL verification — retrying may fix it. */
  expired: "expired",
  /** The provider rejected the code exchange — our configuration problem, and
   * retrying will NOT fix it. */
  provider: "provider",
  /** OAuth'd account didn't match the registered member, or they're no longer
   * an admin. */
  denied: "denied",
  /** Tried to add a calendar that already belongs to someone else here. */
  taken: "taken",
  /** Signed in fine, but unticked a permission we can't work without. */
  permissions: "permissions",
  /** The authorisation code had already been redeemed — almost always a reload,
   * a back button, or a double click on the consent screen, meaning the FIRST
   * attempt succeeded. Kept distinct from `provider` because it is not a fault
   * and telling someone it was one sends them chasing a problem that isn't
   * there. */
  used: "used",
} as const;

type FailureStatus = (typeof FAILURE_STATUS)[keyof typeof FAILURE_STATUS];

function failureRedirect(status: FailureStatus) {
  return NextResponse.redirect(new URL(`/connect?status=${status}`, env.APP_URL));
}

export async function GET(request: Request, { params }: { params: Promise<{ provider: string }> }) {
  const { provider: providerParam } = await params;
  if (!(CALENDAR_PROVIDERS as readonly string[]).includes(providerParam)) {
    console.warn("[auth/callback] unknown provider in URL", { providerParam });
    return failureRedirect(FAILURE_STATUS.expired);
  }
  const provider = asCalendarProvider(providerParam);

  const { searchParams } = new URL(request.url);
  const code = searchParams.get("code");
  const state = searchParams.get("state");

  // Providers report a user-cancelled consent here rather than by omitting the
  // code. Logging it separately keeps "they clicked Cancel" from looking like a
  // configuration fault.
  const oauthError = searchParams.get("error");
  if (oauthError) {
    console.warn("[auth/callback] provider returned an error", {
      provider,
      error: oauthError,
      description: searchParams.get("error_description"),
    });
    return failureRedirect(
      oauthError === "access_denied" ? FAILURE_STATUS.denied : FAILURE_STATUS.provider
    );
  }

  if (!code || !state) {
    console.warn("[auth/callback] missing OAuth params", {
      provider,
      hasCode: !!code,
      hasState: !!state,
    });
    return failureRedirect(FAILURE_STATUS.expired);
  }

  const statePayload = await verifyValue<{
    memberId: number;
    redirectTo?: "admin";
    /** Set only by routes that already run behind a proven session — see the
     * identity check below for why that distinction is what makes adding a
     * second calendar safe. */
    addCalendar?: boolean;
  }>(TOKEN_PURPOSE.connectState, state, env.SESSION_SECRET);
  if (!statePayload || typeof statePayload.memberId !== "number") {
    // Never log the token itself — it's signed with SESSION_SECRET.
    console.warn(
      "[auth/callback] state token rejected (expired, tampered, or signed with a rotated SESSION_SECRET)"
    );
    return failureRedirect(FAILURE_STATUS.expired);
  }

  let exchanged;
  try {
    exchanged = await exchangeCode(provider, code);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);

    // A code can only be redeemed once. Getting here with `invalid_grant`
    // therefore means this exact callback URL was opened twice — a reload, the
    // back button, or a double click on the "unverified app" interstitial — and
    // the FIRST open is the one that worked. Observed in production on
    // 2026-08-21: 12:33:15 succeeded, 12:33:23 replayed the same code, and the
    // person who was by then correctly connected got told their calendar
    // provider was misconfigured on our side.
    //
    // Deliberately NOT treated as a login. It is tempting to notice the member
    // already has a working connection and just hand them a session — do not.
    // The state token is minted by /api/connect/start, which is public and
    // takes a bare email address, so anyone who knows a registered address can
    // obtain a token carrying that member's id. Issuing a session on a FAILED
    // exchange would turn that into a complete authentication bypass: the code
    // exchange is the only thing in this route that proves the person at the
    // other end owns the account. Say what happened, mint nothing.
    if (/invalid_grant/i.test(detail)) {
      console.warn("[auth/callback] authorisation code already redeemed", {
        provider,
        memberId: statePayload.memberId,
      });
      return failureRedirect(FAILURE_STATUS.used);
    }

    // Never swallow this. It is the only place the real reason for a failed
    // connection is visible, and discarding it once made a hard-down login look
    // like an expired link for three days. GoogleApiError and MicrosoftApiError
    // both carry the provider's own body in `message`.
    console.error("[auth/callback] code exchange failed", {
      provider,
      memberId: statePayload.memberId,
      error: detail,
    });
    return failureRedirect(FAILURE_STATUS.provider);
  }

  // Google issues a refresh token only on a FIRST authorisation, which is why
  // buildGoogleAuthUrl always sends prompt=consent. If one still doesn't arrive
  // we must not save the connection: it would look connected, work for an hour,
  // and then go quiet with nothing on screen to explain it.
  if (!exchanged.refreshToken) {
    console.error("[auth/callback] provider returned no refresh token", {
      provider,
      memberId: statePayload.memberId,
      email: exchanged.email,
    });
    return failureRedirect(FAILURE_STATUS.provider);
  }

  // Whoever finished this OAuth round trip has to actually own the account
  // we're about to bind to statePayload.memberId. NOTHING before this point
  // establishes that: the sign-in route is public and takes a bare email, so
  // anyone who knows a registered address can start a flow carrying that
  // member's id and then authenticate as themselves. login_hint is a hint, not
  // a constraint.
  //
  // Without this the callback would hand them a session as that member and
  // overwrite that member's connection — and because invites resolve to
  // grant_email, every future invite for the victim would be delivered to the
  // attacker's inbox while their availability was read from the attacker's
  // calendar. Everything below must stay below it.
  const targetMember = await getMemberById(statePayload.memberId);
  if (!targetMember) {
    console.warn("[auth/callback] state token names a member that no longer exists", {
      memberId: statePayload.memberId,
    });
    return failureRedirect(FAILURE_STATUS.denied);
  }

  const signedInEmail = normalizeEmail(exchanged.email);
  const isRegisteredEmail = signedInEmail === normalizeEmail(targetMember.email);

  // A member may legitimately hold a calendar under a different address than
  // the one they're registered with — a personal Gmail against a work address.
  // That stays allowed, but only for an account ALREADY linked to this member:
  // the FIRST binding must prove ownership of the registered address, and that
  // is what closes the takeover. An attacker has no way to create that first
  // link, so there is nothing here for them to match against.
  let previouslyLinked = false;
  if (!isRegisteredEmail) {
    const linked = await db
      .select({ grantEmail: calendarConnections.grantEmail })
      .from(calendarConnections)
      .where(eq(calendarConnections.memberId, targetMember.id));
    previouslyLinked = linked.some((row) => normalizeEmail(row.grantEmail) === signedInEmail);
  }

  // Adding a second calendar is the one case where a brand-new, unrelated
  // address is legitimate. It's safe only because this flag can exist nowhere
  // but a token minted behind an established session, and the token is
  // HMAC-signed so the flag can't be bolted on from outside.
  const addingCalendar = statePayload.addCalendar === true;

  if (!isRegisteredEmail && !previouslyLinked && !addingCalendar) {
    console.warn("[auth/callback] identity check failed — signed-in account is not this member", {
      memberId: statePayload.memberId,
      expectedEmail: targetMember.email,
      actualEmail: exchanged.email,
    });
    return failureRedirect(FAILURE_STATUS.denied);
  }

  let grantAdminSession = false;
  if (statePayload.redirectTo === "admin") {
    // Signing in as an admin demands the registered address itself: typing an
    // address proves nothing, so the OAuth round trip has to land on the
    // account that address belongs to. Repairing or adding a calendar is not
    // signing in — that identity proof already happened, at the session,
    // before the flow started. hasAdminAccess is re-checked live either way, in
    // case they lost access during the round trip.
    const identityProven = isRegisteredEmail || addingCalendar;
    if (!identityProven || !(await hasAdminAccess(targetMember.email))) {
      console.warn("[auth/callback] admin verification failed", {
        memberId: statePayload.memberId,
        expectedEmail: targetMember.email,
        actualEmail: exchanged.email,
      });
      return failureRedirect(FAILURE_STATUS.denied);
    }
    grantAdminSession = true;
  }

  // Did they actually grant what we asked for?
  //
  // The consent screen has a checkbox per permission and people can untick
  // them — which is a legitimate thing to do, and someone did. Without this
  // check the flow completes, we store a token that works for signing in and
  // for nothing else, the UI reports a healthy calendar, and the first
  // availability search days later fails with a 403 naming a person who
  // believes they connected successfully.
  //
  // Refusing here costs one confusing minute at exactly the moment the person
  // can fix it, instead of silently removing them from every search. Nothing is
  // written to the database on this path: a half-granted connection is worse
  // than none, because none is visible.
  const missing = missingCapabilities(
    provider,
    await calendarAccessFor(targetMember),
    exchanged.grantedScopes
  );
  if (missing.length > 0) {
    console.warn("[auth/callback] connection refused — permissions withheld", {
      provider,
      memberId: targetMember.id,
      email: signedInEmail,
      missing,
      granted: exchanged.grantedScopes,
    });
    return failureRedirect(FAILURE_STATUS.permissions);
  }

  // Two lookups, because "which row do I update" and "does this belong to
  // someone else" are different questions.
  //
  // The row to write is keyed on provider + address: a Google and a Microsoft
  // calendar under one address are genuinely two calendars and get two rows.
  //
  // Ownership is keyed on the ADDRESS ALONE, across every provider. One mailbox
  // is one person, and matching on provider too let the same address attach to
  // two different members — one via Google, one via Microsoft. That is not
  // hypothetical: it put a Team member's address in the Founders list, because
  // the People page shows the address that receives invites.
  const rowsForAddress = await db
    .select({
      id: calendarConnections.id,
      memberId: calendarConnections.memberId,
      provider: calendarConnections.provider,
    })
    .from(calendarConnections)
    .where(eq(calendarConnections.grantEmail, signedInEmail));

  /** The row this sign-in writes to, if it already exists. */
  const sameProviderRow = rowsForAddress.find((row) => row.provider === provider);
  /** Anyone else holding this address, under ANY provider. */
  const otherMember = rowsForAddress.find((row) => row.memberId !== statePayload.memberId);

  if (otherMember) {
    // Reassigning is right when someone is SIGNING IN: they just proved they
    // own this mailbox, so it belongs to them and whoever held it before was
    // wrong. It is not right when someone is ADDING a calendar to their own
    // profile — that would quietly strip another member of their connection,
    // leaving them unbookable with nothing on screen to explain it.
    if (addingCalendar) {
      console.warn("[auth/callback] refused to attach a calendar already held by another member", {
        provider,
        email: signedInEmail,
        heldBy: otherMember.memberId,
        requestedBy: statePayload.memberId,
      });
      return failureRedirect(FAILURE_STATUS.taken);
    }

    // Every row for this address moves, not just the one for this provider —
    // otherwise the Microsoft row stays behind on the old member and their
    // People entry keeps showing an address that is no longer theirs.
    const strayIds = rowsForAddress
      .filter((row) => row.memberId !== statePayload.memberId)
      .map((row) => row.id);
    console.warn(
      `[auth/callback] ${signedInEmail} was held by member ${otherMember.memberId}, reassigning ${strayIds.length} row(s) to member ${statePayload.memberId}`
    );
    await db
      .update(calendarConnections)
      .set({ memberId: statePayload.memberId, isPrimary: false })
      .where(inArray(calendarConnections.id, strayIds));
  }

  // Whether this member already had a usable calendar BEFORE this one, and
  // which of them was receiving sessions. Read now, because the write below
  // changes the answer.
  const priorUsable = await getActiveConnections([statePayload.memberId]);
  const priorTarget = pickInviteConnection(priorUsable);

  const tokenFields = encryptedTokenFields(exchanged);
  const connectionFields = {
    memberId: statePayload.memberId,
    provider,
    grantEmail: signedInEmail,
    connectionStatus: "connected" as const,
    connectedAt: new Date(),
    revokedAt: null,
    ...tokenFields,
  };

  // Update-or-insert done explicitly rather than with onConflictDoUpdate: there
  // is no unique index on (provider, grant_email), and adding one could fail
  // against rows left over from the Nylas era where the same address was
  // connected by two different members over time.
  let connectionId: number;
  if (sameProviderRow) {
    await db
      .update(calendarConnections)
      .set(connectionFields)
      .where(eq(calendarConnections.id, sameProviderRow.id));
    connectionId = sameProviderRow.id;
  } else {
    const [created] = await db
      .insert(calendarConnections)
      .values(connectionFields)
      .returning({ id: calendarConnections.id });
    connectionId = created.id;
  }

  // Pin which calendar receives sessions, the first time there's anything to
  // pin. Without this the answer came from pickInviteConnection's fallback
  // ordering, which meant connecting a second calendar silently moved
  // everyone's invites onto it — you set out to add a calendar and quietly
  // changed where your meetings land.
  //
  // Someone who already had a target keeps it; someone connecting for the very
  // first time gets this one.
  // Asked of EVERY row, not just the usable ones.
  //
  // This used to read `!priorUsable.some((r) => r.is_primary)`, and the gap
  // between those two sets is a real state: a row that is `connected` but
  // carries a NULL refresh token — a leftover from the Nylas era — is excluded
  // from priorUsable while still holding the flag. The unique index behind this
  // (calendar_connections_one_primary_per_member, schema.ts) is partial on
  // is_primary alone and knows nothing about status or tokens, so the guard
  // opened and the write then collided with the very row it had overlooked.
  // Seen in production on 2026-08-21: member 8, "Key (member_id)=(8) already
  // exists", on every single reconnect.
  //
  // Because the failure is caught below rather than fatal, nobody saw an error.
  // The symptom was that the pin never took, leaving the invite target to
  // pickInviteConnection's fallback ordering — exactly the drift this pin
  // exists to prevent.
  //
  // Reading the flag directly is also the honest question. "Has this member
  // already chosen where sessions land?" is a fact about the rows, and
  // answering it from a filtered subset is what made it wrong.
  const [existingPin] = await db
    .select({ id: calendarConnections.id })
    .from(calendarConnections)
    .where(
      and(
        eq(calendarConnections.memberId, statePayload.memberId),
        eq(calendarConnections.isPrimary, true)
      )
    )
    .limit(1);

  if (!existingPin) {
    const pinTo = priorTarget?.id ?? connectionId;
    try {
      await db
        .update(calendarConnections)
        .set({ isPrimary: true })
        .where(eq(calendarConnections.id, pinTo));
    } catch (err) {
      // Not fatal: the fallback still returns a sensible, stable answer, and
      // the member can set it themselves on /me.
      console.error("[auth/callback] Couldn't pin the invite calendar", {
        memberId: statePayload.memberId,
        err,
      });
    }
  }

  // A successful connection doubles as login. Admins land on the dashboard they
  // came for, advisors on their own panel, everyone else on member settings.
  // The advisor check is a live DB read rather than something carried in the
  // state token, so promoting someone to advisor takes effect on their next
  // sign-in instead of whenever a stale token expires.
  const memberSessionToken = await signValue(
    TOKEN_PURPOSE.memberSession,
    { memberId: statePayload.memberId },
    env.SESSION_SECRET,
    MEMBER_SESSION_TTL_SECONDS
  );
  let destination = "/me";
  if (statePayload.redirectTo === "admin") {
    destination = "/admin/find-a-time";
  } else if (targetMember.isAdvisor) {
    destination = "/advisor";
  }

  const response = NextResponse.redirect(new URL(destination, env.APP_URL));
  response.cookies.set(MEMBER_COOKIE_NAME, memberSessionToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: MEMBER_SESSION_TTL_SECONDS,
    path: "/",
  });
  // Only reached when redirectTo === "admin" AND the verification above passed
  // — this is the one and only place an admin session is ever minted.
  if (grantAdminSession) {
    // targetMember.email, NOT signedInEmail. These are the same address on a
    // sign-in, but deliberately allowed to differ when an admin is adding or
    // repairing a calendar (identityProven accepts addingCalendar on its own).
    // The address just authorised above is the member's — minting the cookie
    // with the other one hands the session an identity nobody checked.
    //
    // It also broke the ordinary case, fail-closed: an admin connecting a
    // personal Gmail got a cookie naming that address, and since the tier is
    // re-derived from the cookie on every request (resolveAdminTier), the next
    // one found no allowlist entry and no member row and ejected them from the
    // admin area — via the very button that promises it won't.
    await setAdminSessionCookie(response, targetMember.email);
  }
  return response;
}
