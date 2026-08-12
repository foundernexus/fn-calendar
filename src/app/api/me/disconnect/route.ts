import { NextResponse } from "next/server";
import { eq, and } from "drizzle-orm";
import { db } from "@/db";
import { calendarConnections } from "@/db/schema";
import { requireMemberSession } from "@/lib/auth/member";

/** Session-authenticated sibling of the existing open `/api/connect/disconnect`
 * (which trusts a client-supplied email with no auth at all — a known,
 * already-accepted V1 gap left untouched). This one derives the member from
 * the session instead, so it can only ever disconnect the caller's own
 * calendar. Local flag only, same as the original — does not call Nylas to
 * revoke the real OAuth grant. */
export async function POST() {
  const session = await requireMemberSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  await db
    .update(calendarConnections)
    .set({ connectionStatus: "revoked", revokedAt: new Date() })
    .where(
      and(
        eq(calendarConnections.memberId, session.memberId),
        eq(calendarConnections.connectionStatus, "connected")
      )
    );

  return NextResponse.json({ status: "revoked" });
}
