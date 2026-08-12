import { NextResponse } from "next/server";
import { requireMemberSession } from "@/lib/auth/member";
import { signValue, TOKEN_PURPOSE } from "@/lib/auth/session";
import { buildHostedAuthUrl } from "@/lib/nylas";
import { normalizeEmail } from "@/lib/email";
import { env } from "@/lib/env";

const STATE_TTL_SECONDS = 60 * 10; // 10 minutes — matches /api/connect/start

/** Same hosted-auth-URL flow as /api/connect/start, but the member and their
 * email come from the session instead of a client-supplied one — used by the
 * "Reconnect" button on /me so a member whose connection has broken can get
 * back in without an admin. */
export async function POST() {
  const session = await requireMemberSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const state = await signValue(
    TOKEN_PURPOSE.connectState,
    { memberId: session.memberId },
    env.SESSION_SECRET,
    STATE_TTL_SECONDS
  );
  const url = buildHostedAuthUrl({
    loginHint: normalizeEmail(session.member.email),
    state,
  });

  return NextResponse.json({ url });
}
