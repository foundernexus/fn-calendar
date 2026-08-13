import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { calendarConnections } from "@/db/schema";
import { getMemberById } from "@/db/queries";
import {
  signValue,
  verifyValue,
  TOKEN_PURPOSE,
  MEMBER_COOKIE_NAME,
  MEMBER_SESSION_TTL_SECONDS,
} from "@/lib/auth/session";
import { isAdminEmail, setAdminSessionCookie } from "@/lib/auth/admin";
import { exchangeNylasCode } from "@/lib/nylas";
import { normalizeEmail } from "@/lib/email";
import { env } from "@/lib/env";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get("code");
  const state = searchParams.get("state");

  if (!code || !state) {
    return NextResponse.redirect(new URL("/connect?status=error", env.APP_URL));
  }

  const statePayload = await verifyValue<{ memberId: number; redirectTo?: "admin" }>(
    TOKEN_PURPOSE.connectState,
    state,
    env.SESSION_SECRET
  );
  if (!statePayload || typeof statePayload.memberId !== "number") {
    return NextResponse.redirect(new URL("/connect?status=error", env.APP_URL));
  }

  let exchanged;
  try {
    exchanged = await exchangeNylasCode(code);
  } catch {
    return NextResponse.redirect(new URL("/connect?status=error", env.APP_URL));
  }

  // Admin login is only ever granted here, never on the bare email POSTed to
  // /api/connect/start — typing a string isn't proof of owning that inbox.
  // The Google/Microsoft account actually signed into during this OAuth round
  // trip must match the admin's registered email exactly, and they must
  // still be on the live ADMIN_EMAILS allowlist (in case they were removed
  // while this 10-minute flow was in flight). On any mismatch, bail out
  // BEFORE touching calendar_connections — an attacker who requested this
  // flow for someone else's memberId but authenticated with their own
  // account must not silently overwrite that person's real connection.
  let grantAdminSession = false;
  if (statePayload.redirectTo === "admin") {
    const targetMember = await getMemberById(statePayload.memberId);
    const emailMatches =
      !!targetMember && normalizeEmail(exchanged.email) === normalizeEmail(targetMember.email);
    const stillAdmin = !!targetMember && isAdminEmail(targetMember.email, env.ADMIN_EMAILS);
    if (!emailMatches || !stillAdmin) {
      console.warn("[nylas/callback] admin verification failed", {
        memberId: statePayload.memberId,
        expectedEmail: targetMember?.email,
        actualEmail: exchanged.email,
      });
      return NextResponse.redirect(new URL("/connect?status=error", env.APP_URL));
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
    console.warn(
      `[nylas/callback] grant ${exchanged.grantId} was connected to member ${existing.memberId}, now reassigned to member ${statePayload.memberId}`
    );
  }

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
  const destination = statePayload.redirectTo === "admin" ? "/admin/find-a-time" : "/me";
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
    await setAdminSessionCookie(response, exchanged.email);
  }
  return response;
}
