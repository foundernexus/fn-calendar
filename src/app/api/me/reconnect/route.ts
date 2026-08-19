import { NextResponse } from "next/server";
import { requireMemberSession } from "@/lib/auth/member";
import { getLatestConnections, pickInviteConnection } from "@/db/queries";
import { signValue, TOKEN_PURPOSE } from "@/lib/auth/session";
import { asCalendarProvider, buildHostedAuthUrl } from "@/lib/nylas";
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
  // Reconnect with whatever they connected last time — this button exists
  // precisely because their existing connection broke, so silently sending an
  // Outlook user to Google would hand them a second, wrong calendar rather
  // than repairing the one they came here to fix.
  // pickInviteConnection, not rows[0]. getLatestConnections returns one row
  // per calendar now that a member can hold several, ordered by grant_email —
  // taking the first would pick whichever address sorts alphabetically first
  // and could send someone with both Google and Microsoft to the wrong one.
  const existing = pickInviteConnection(await getLatestConnections([session.memberId]));
  const url = buildHostedAuthUrl({
    // The address of the calendar being REPAIRED, not the registered one.
    // Those differ whenever someone connected a personal account against a
    // work address, and hinting the registered address sent them to a
    // different account entirely: the broken calendar stayed broken and the
    // upsert added a second one, costing another Nylas grant. Falls back to
    // the registered address when there's nothing to repair — this button
    // doubles as first-time connect.
    loginHint: normalizeEmail(existing?.grant_email ?? session.member.email),
    state,
    provider: asCalendarProvider(existing?.provider),
  });

  return NextResponse.json({ url });
}
