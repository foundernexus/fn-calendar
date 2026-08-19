import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
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
    // Never swallow this. It is the only place the real reason for a failed
    // connection is visible, and discarding it once made a hard-down login look
    // like an expired link for three days. GoogleApiError and MicrosoftApiError
    // both carry the provider's own body in `message`.
    console.error("[auth/callback] code exchange failed", {
      provider,
      memberId: statePayload.memberId,
      error: err instanceof Error ? err.message : String(err),
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

  // A calendar account is identified by provider + address now that there's no
  // grant id. Same purpose the unique grant id served: spotting that this exact
  // account is already connected, possibly by somebody else.
  const [existing] = await db
    .select({ id: calendarConnections.id, memberId: calendarConnections.memberId })
    .from(calendarConnections)
    .where(
      and(
        eq(calendarConnections.provider, provider),
        eq(calendarConnections.grantEmail, signedInEmail)
      )
    )
    .limit(1);

  if (existing && existing.memberId !== statePayload.memberId) {
    // Reassigning is right when someone is SIGNING IN: they just proved they
    // own this calendar, so it belongs to them and whoever held it before was
    // wrong. It is not right when someone is ADDING a calendar to their own
    // profile — that would quietly strip another member of their connection,
    // leaving them unbookable with nothing on screen to explain it.
    if (addingCalendar) {
      console.warn("[auth/callback] refused to attach a calendar already held by another member", {
        provider,
        email: signedInEmail,
        heldBy: existing.memberId,
        requestedBy: statePayload.memberId,
      });
      return failureRedirect(FAILURE_STATUS.taken);
    }
    console.warn(
      `[auth/callback] ${provider} calendar ${signedInEmail} was connected to member ${existing.memberId}, now reassigned to member ${statePayload.memberId}`
    );
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
  if (existing) {
    await db
      .update(calendarConnections)
      .set(connectionFields)
      .where(eq(calendarConnections.id, existing.id));
    connectionId = existing.id;
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
  if (!priorUsable.some((r) => r.is_primary)) {
    try {
      await db
        .update(calendarConnections)
        .set({ isPrimary: true })
        .where(eq(calendarConnections.id, priorTarget?.id ?? connectionId));
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
    await setAdminSessionCookie(response, signedInEmail);
  }
  return response;
}
