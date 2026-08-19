import { NextResponse } from "next/server";
import { eq, and } from "drizzle-orm";
import { db } from "@/db";
import { calendarConnections } from "@/db/schema";
import { requireMemberSession } from "@/lib/auth/member";
import { getActiveConnections } from "@/db/queries";
import { revokeToken, asCalendarProvider } from "@/lib/calendar";
import { decryptToken } from "@/lib/calendar/crypto";

/** Disconnects ALL of the caller's calendars — the "stop scheduling me
 * entirely" action. Removing one of several lives in /api/me/calendars.
 *
 * Derives the member from the session, so it can only ever disconnect the
 * caller's own calendars.
 *
 * Hands each token back to the provider as well as marking the rows revoked.
 * Marking them locally alone would leave us holding a live token for the
 * calendar of somebody who had just explicitly disconnected. Best-effort and
 * deliberately not fatal: a token that can't be revoked must not leave someone
 * unable to disconnect.
 *
 * Google revokes properly. Microsoft has no per-token revocation — the nearest
 * equivalents sign the user out of everything, everywhere — so for Microsoft
 * the token is deleted here and the app instantly loses all access, but the
 * consent entry stays listed under their Microsoft account until they remove it
 * themselves. `providerRevocationIncomplete` tells the caller which happened,
 * so the UI can say what's true rather than claiming a revocation that didn't
 * occur.
 *
 * `is_primary` is cleared with them. It marks which calendar receives
 * sessions, and a revoked row that kept the flag would collide with the
 * partial unique index the next time a calendar was connected, silently
 * breaking the pin. */
export async function POST() {
  const session = await requireMemberSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let grantRevokeFailed = false;
  let providerRevocationIncomplete = false;
  try {
    const usable = await getActiveConnections([session.memberId]);
    for (const connection of usable) {
      if (!connection.refresh_token_encrypted) continue;
      try {
        const result = await revokeToken({
          provider: asCalendarProvider(connection.provider),
          refreshToken: decryptToken(connection.refresh_token_encrypted),
        });
        if (!result.revokedAtProvider) providerRevocationIncomplete = true;
      } catch (err) {
        grantRevokeFailed = true;
        console.error("[api/me/disconnect] Token revoke failed", {
          memberId: session.memberId,
          connectionId: connection.id,
          err,
        });
      }
    }
  } catch (err) {
    grantRevokeFailed = true;
    console.error("[api/me/disconnect] Reading connections failed", {
      memberId: session.memberId,
      err,
    });
  }

  try {
    await db
      .update(calendarConnections)
      .set({ connectionStatus: "revoked", revokedAt: new Date(), isPrimary: false })
      .where(
        and(
          eq(calendarConnections.memberId, session.memberId),
          eq(calendarConnections.connectionStatus, "connected")
        )
      );
  } catch (err) {
    console.error("[api/me/disconnect] Marking rows revoked failed", {
      memberId: session.memberId,
      err,
    });
    return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 });
  }

  return NextResponse.json({ status: "revoked", grantRevokeFailed, providerRevocationIncomplete });
}
