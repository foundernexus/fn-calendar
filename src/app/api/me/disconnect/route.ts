import { NextResponse } from "next/server";
import { eq, and } from "drizzle-orm";
import { db } from "@/db";
import { calendarConnections } from "@/db/schema";
import { requireMemberSession } from "@/lib/auth/member";
import { getActiveConnections } from "@/db/queries";
import { revokeNylasGrant } from "@/lib/nylas";

/** Disconnects ALL of the caller's calendars — the "stop scheduling me
 * entirely" action. Removing one of several lives in /api/me/calendars.
 *
 * Derives the member from the session, so it can only ever disconnect the
 * caller's own calendars.
 *
 * Revokes each grant at Nylas as well as marking the rows revoked. Marking
 * them locally alone left Nylas holding a live token for the calendar of
 * somebody who had just explicitly disconnected — still readable, still
 * counting against the plan's connected-calendar allowance. Best-effort, and
 * deliberately not fatal: a grant that can't be revoked must not leave someone
 * unable to disconnect, but the caller is told so the leftover can be cleared
 * in the Nylas dashboard.
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
  try {
    const usable = await getActiveConnections([session.memberId]);
    for (const grantId of new Set(usable.map((c) => c.nylas_grant_id))) {
      try {
        await revokeNylasGrant(grantId);
      } catch (err) {
        grantRevokeFailed = true;
        console.error("[api/me/disconnect] Grant revoke failed", {
          memberId: session.memberId,
          grantId,
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

  return NextResponse.json({ status: "revoked", grantRevokeFailed });
}
