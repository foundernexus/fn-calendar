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
import { exchangeNylasCode } from "@/lib/nylas";
import { normalizeEmail } from "@/lib/email";
import { env } from "@/lib/env";
import { NylasApiError, NylasOAuthError } from "nylas";

/** Which bail-out sent the user back to /connect. The page renders a different
 * message per status (src/app/connect/page.tsx) — a single generic "the link
 * may have expired" is actively misleading when the real cause is a Nylas
 * misconfiguration, and it cost real debugging time on 2026-08-17. */
const FAILURE_STATUS = {
  /** State token missing or failed HMAC/TTL verification — the user's problem, retrying may fix it. */
  expired: "expired",
  /** Nylas rejected the code exchange — our configuration problem, retrying will NOT fix it. */
  provider: "provider",
  /** OAuth'd account didn't match the registered member, or they're no longer an admin. */
  denied: "denied",
  /** Tried to add a calendar that's already another member's connection.
   * Attaching it would have taken it off them. */
  taken: "taken",
} as const;

type FailureStatus = (typeof FAILURE_STATUS)[keyof typeof FAILURE_STATUS];

function failureRedirect(status: FailureStatus) {
  return NextResponse.redirect(new URL(`/connect?status=${status}`, env.APP_URL));
}

/** Nylas throws two different error shapes and neither has a usable `message`
 * on its own. The OAuth endpoints (including /connect/token) throw
 * NylasOAuthError, whose errorDescription is the only field that actually says
 * why a 403 happened — which app, which key, which redirect URI. Pull the
 * fields out explicitly so they survive into the Vercel logs. */
function describeNylasError(err: unknown) {
  if (err instanceof NylasOAuthError) {
    return {
      kind: "NylasOAuthError",
      statusCode: err.statusCode,
      error: err.error,
      errorCode: err.errorCode,
      errorDescription: err.errorDescription,
      errorUri: err.errorUri,
      requestId: err.requestId,
    };
  }
  if (err instanceof NylasApiError) {
    return {
      kind: "NylasApiError",
      statusCode: err.statusCode,
      type: err.type,
      message: err.message,
      providerError: err.providerError,
      requestId: err.requestId,
    };
  }
  return { kind: "unknown", message: err instanceof Error ? err.message : String(err) };
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get("code");
  const state = searchParams.get("state");

  if (!code || !state) {
    console.warn("[nylas/callback] missing OAuth params", {
      hasCode: !!code,
      hasState: !!state,
    });
    return failureRedirect(FAILURE_STATUS.expired);
  }

  const statePayload = await verifyValue<{
    memberId: number;
    redirectTo?: "admin";
    /** Set only by /api/me/calendars, which runs behind a member session — see
     * the identity check below for why that distinction is what makes adding a
     * second calendar safe. */
    addCalendar?: boolean;
  }>(
    TOKEN_PURPOSE.connectState,
    state,
    env.SESSION_SECRET
  );
  if (!statePayload || typeof statePayload.memberId !== "number") {
    // Don't log the token itself — it's signed with SESSION_SECRET.
    console.warn("[nylas/callback] state token rejected (expired, tampered, or signed with a rotated SESSION_SECRET)");
    return failureRedirect(FAILURE_STATUS.expired);
  }

  let exchanged;
  try {
    exchanged = await exchangeNylasCode(code);
  } catch (err) {
    // Never swallow this. It is the ONLY place the real reason for a failed
    // connection is visible, and discarding it made a hard-down login look
    // like an expired link for three days.
    console.error("[nylas/callback] Nylas code exchange failed", {
      memberId: statePayload.memberId,
      apiUri: env.NYLAS_API_URI,
      ...describeNylasError(err),
    });
    return failureRedirect(FAILURE_STATUS.provider);
  }

  // Whoever finished this OAuth round trip has to actually own the account
  // we're about to bind to statePayload.memberId. NOTHING before this point
  // establishes that: /api/connect/start is public and takes a bare email, so
  // anyone who knows a registered address can start a flow carrying that
  // member's id and then authenticate as themselves. loginHint is a hint, not
  // a constraint.
  //
  // Without this the callback would hand them a session as that member and
  // overwrite that member's calendar_connections row — and because invites
  // resolve to grant_email, every future invite for the victim would be
  // delivered to the attacker's inbox while their availability was read from
  // the attacker's calendar.
  //
  // This check existed, but lived INSIDE the `redirectTo === "admin"` branch,
  // so it only ever ran for admins. Everything below it must stay below it.
  const targetMember = await getMemberById(statePayload.memberId);
  if (!targetMember) {
    console.warn("[nylas/callback] state token names a member that no longer exists", {
      memberId: statePayload.memberId,
    });
    return failureRedirect(FAILURE_STATUS.denied);
  }

  const signedInEmail = normalizeEmail(exchanged.email);
  const isRegisteredEmail = signedInEmail === normalizeEmail(targetMember.email);

  // A member may legitimately hold a calendar under a different address than
  // the one they're registered with — a personal Gmail against a work address,
  // say. That stays allowed, but only for an account ALREADY linked to this
  // member: the FIRST binding must prove ownership of the registered address,
  // and that is what closes the takeover. An attacker has no way to create
  // that first link, so there is nothing here for them to match against.
  let previouslyLinked = false;
  if (!isRegisteredEmail) {
    const linked = await db
      .select({ grantEmail: calendarConnections.grantEmail })
      .from(calendarConnections)
      .where(eq(calendarConnections.memberId, targetMember.id));
    previouslyLinked = linked.some((row) => normalizeEmail(row.grantEmail) === signedInEmail);
  }

  // Adding a second calendar is the one case where a brand-new, unrelated
  // address is legitimate — a personal Google alongside a work one. It's safe
  // only because this flag can exist nowhere but a token minted by
  // /api/me/calendars, which sits behind requireMemberSession: the person was
  // already proven to be this member before the flow started, and the token is
  // HMAC-signed so the flag can't be bolted on from outside. The public
  // sign-in path (/api/connect/start) never sets it, so the takeover it closes
  // stays closed.
  const addingCalendar = statePayload.addCalendar === true;

  if (!isRegisteredEmail && !previouslyLinked && !addingCalendar) {
    console.warn("[nylas/callback] identity check failed — signed-in account is not this member", {
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
    // account that address belongs to.
    //
    // Repairing a calendar is not signing in. /api/admin/connect-calendar runs
    // behind an existing admin session and tags its state `addCalendar`, and
    // the calendar being repaired can legitimately sit under a different
    // address than the registered one. Demanding a match there rejected the
    // very people it was meant to protect. The identity proof for that path
    // already happened — at the session, before the flow started — and the
    // flag cannot be set from outside a signed token.
    //
    // hasAdminAccess is re-checked live either way, in case they lost access
    // during this 10-minute round trip.
    const identityProven = isRegisteredEmail || addingCalendar;
    if (!identityProven || !(await hasAdminAccess(targetMember.email))) {
      console.warn("[nylas/callback] admin verification failed", {
        memberId: statePayload.memberId,
        expectedEmail: targetMember.email,
        actualEmail: exchanged.email,
      });
      return failureRedirect(FAILURE_STATUS.denied);
    }
    grantAdminSession = true;
  }

  const provider = exchanged.provider ?? "unknown";

  // nylas_grant_id is globally unique, so if this exact calendar account was
  // previously connected by a DIFFERENT member, this silently moves the row to
  // the new member (the old member goes back to "not connected", with no
  // record of why). That's the correct behavior — the alternative of keeping
  // the stale memberId would misattribute the connection — but it's worth a
  // loud warning since re-using one test Google account across two seeded
  // members during Step 6 testing will otherwise look like an unrelated bug.
  const [existing] = await db
    .select({ memberId: calendarConnections.memberId })
    .from(calendarConnections)
    .where(eq(calendarConnections.nylasGrantId, exchanged.grantId))
    .limit(1);
  if (existing && existing.memberId !== statePayload.memberId) {
    // Reassigning is right when someone is SIGNING IN: they just proved they
    // own this calendar, so it belongs to them and whoever held it before was
    // wrong. It is not right when someone is ADDING a calendar to their own
    // profile — that would quietly strip another member of their connection,
    // leaving them unbookable with nothing on screen to explain it. Refuse and
    // let them pick a different account.
    if (addingCalendar) {
      console.warn("[nylas/callback] refused to attach a calendar already held by another member", {
        grantId: exchanged.grantId,
        heldBy: existing.memberId,
        requestedBy: statePayload.memberId,
      });
      return failureRedirect(FAILURE_STATUS.taken);
    }
    console.warn(
      `[nylas/callback] grant ${exchanged.grantId} was connected to member ${existing.memberId}, now reassigned to member ${statePayload.memberId}`
    );
  }

  // Whether this member already had a usable calendar BEFORE this one, and
  // which of them was receiving sessions. Read now, because the upsert below
  // changes the answer.
  const priorUsable = await getActiveConnections([statePayload.memberId]);
  const priorTarget = pickInviteConnection(priorUsable);

  // Upsert on nylas_grant_id: Nylas's loginHint auto-reauths an existing grant,
  // so a member reconnecting after a local "disconnect" likely gets back the
  // SAME grant ID — a plain insert would hit the unique constraint. Resetting
  // connection_status/connected_at/revoked_at here is what actually makes
  // reconnect work (a stale connected_at would leave getLatestConnections'
  // ordering wrong, and a stale 'revoked' status would leave them unusable).
  await db
    .insert(calendarConnections)
    .values({
      memberId: statePayload.memberId,
      nylasGrantId: exchanged.grantId,
      provider,
      grantEmail: exchanged.email,
      nylasClientId: env.NYLAS_CLIENT_ID,
      connectionStatus: "connected",
      connectedAt: new Date(),
      revokedAt: null,
    })
    .onConflictDoUpdate({
      target: calendarConnections.nylasGrantId,
      set: {
        memberId: statePayload.memberId,
        provider,
        grantEmail: exchanged.email,
        nylasClientId: env.NYLAS_CLIENT_ID,
        connectionStatus: "connected",
        connectedAt: new Date(),
        revokedAt: null,
      },
    });

  // Pin which calendar receives sessions, the first time there's anything to
  // pin. Without this the answer came from pickInviteConnection's fallback
  // ordering, which meant connecting a second calendar silently moved
  // everyone's invites onto it — you set out to add a calendar and quietly
  // changed where your meetings land.
  //
  // Someone who already had a target keeps it: whatever they were using
  // before is written down explicitly so nothing can shift it later. Someone
  // connecting for the very first time gets this one.
  // Asked of EVERY row rather than only the usable ones — same fix and same
  // reason as the equivalent block in /api/auth/[provider]/callback, where the
  // full explanation lives. Kept in step deliberately: the two share this
  // logic, and fixing one and not the other is how they drift apart.
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
    const pinned = priorTarget
      ? db
          .update(calendarConnections)
          .set({ isPrimary: true })
          .where(eq(calendarConnections.id, priorTarget.id))
      : db
          .update(calendarConnections)
          .set({ isPrimary: true })
          .where(eq(calendarConnections.nylasGrantId, exchanged.grantId));
    try {
      await pinned;
    } catch (err) {
      // Not fatal: the fallback still returns a sensible, stable answer, and
      // the member can set it themselves on /me.
      console.error("[nylas/callback] Couldn't pin the invite calendar", {
        memberId: statePayload.memberId,
        err,
      });
    }
  }

  // A successful connection doubles as login (see /me) — sign a member
  // session and send them straight to their settings page instead of back
  // to /connect. Unless this was an admin connecting their OWN calendar
  // (state tagged `redirectTo: "admin"` in /api/connect/start or
  // /api/admin/connect-calendar) — they still get a member session (so /me
  // works for them too later), but land back on the admin dashboard, not
  // the member settings page, matching what they actually came here to do.
  const memberSessionToken = await signValue(
    TOKEN_PURPOSE.memberSession,
    { memberId: statePayload.memberId },
    env.SESSION_SECRET,
    MEMBER_SESSION_TTL_SECONDS
  );
  // Admins go to the dashboard they came for; advisors get their own panel;
  // everyone else lands on member settings. The advisor check is a DB read
  // rather than something carried in the state token, because the token is
  // minted at /api/connect/start before we know anything about them beyond
  // their email — and because an admin promoting someone to advisor should
  // take effect on their next sign-in, not whenever a stale token expires.
  let destination = "/me";
  if (statePayload.redirectTo === "admin") {
    destination = "/admin/find-a-time";
  } else {
    const member = await getMemberById(statePayload.memberId);
    if (member?.isAdvisor) destination = "/advisor";
  }
  const response = NextResponse.redirect(new URL(destination, env.APP_URL));
  response.cookies.set(MEMBER_COOKIE_NAME, memberSessionToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: MEMBER_SESSION_TTL_SECONDS,
    path: "/",
  });
  // Only reached when redirectTo === "admin" AND the verification above
  // passed — this is the one and only place an admin session is ever minted.
  if (grantAdminSession) {
    // targetMember.email, not the OAuth address — same reasoning as the note
    // in api/auth/[provider]/callback. hasAdminAccess was checked against the
    // member, so the cookie has to name the member.
    await setAdminSessionCookie(response, targetMember.email);
  }
  return response;
}
