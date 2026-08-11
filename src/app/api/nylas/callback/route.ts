import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { calendarConnections } from "@/db/schema";
import { getMemberById } from "@/db/queries";
import { verifyValue, TOKEN_PURPOSE } from "@/lib/auth/session";
import { exchangeNylasCode } from "@/lib/nylas";
import { env } from "@/lib/env";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get("code");
  const state = searchParams.get("state");

  if (!code || !state) {
    return NextResponse.redirect(new URL("/connect?status=error", env.APP_URL));
  }

  const statePayload = await verifyValue<{ memberId: number }>(
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
        connectionStatus: "connected",
        connectedAt: new Date(),
        revokedAt: null,
      },
    });

  // Redirect using the member's registered email (not the Nylas grant's email —
  // someone may connect a personal Gmail that differs from their registered
  // address), so the /connect page's status lookup finds the right member row.
  const member = await getMemberById(statePayload.memberId);
  const redirectUrl = new URL("/connect", env.APP_URL);
  if (member) redirectUrl.searchParams.set("email", member.email);
  redirectUrl.searchParams.set("status", "connected");
  return NextResponse.redirect(redirectUrl);
}
