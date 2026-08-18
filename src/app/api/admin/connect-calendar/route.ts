import { NextResponse } from "next/server";
import { getMemberByEmail, getLatestConnections } from "@/db/queries";
import { requireAdminSession } from "@/lib/auth/admin";
import { signValue, TOKEN_PURPOSE } from "@/lib/auth/session";
import { asCalendarProvider, buildHostedAuthUrl } from "@/lib/nylas";
import { normalizeEmail } from "@/lib/email";
import { env } from "@/lib/env";

const STATE_TTL_SECONDS = 60 * 10; // matches /api/connect/start

/** For an admin who's already on the dashboard and needs to (re)connect
 * their own calendar — e.g. their connection broke, or they skipped it on
 * first login. Same Nylas hosted-auth flow as the member path, tagged
 * `redirectTo: "admin"` so /api/nylas/callback sends them back to the admin
 * dashboard afterward instead of /me (see /api/connect/start for the other
 * place this same tag is used, on an admin's very first login). */
export async function POST() {
  const session = await requireAdminSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const member = await getMemberByEmail(session.email);
  if (!member) {
    return NextResponse.json(
      { error: "Your admin email isn't registered as a member, so there's no calendar to connect. Ask another admin to add you as a member first." },
      { status: 404 }
    );
  }

  const state = await signValue(
    TOKEN_PURPOSE.connectState,
    { memberId: member.id, redirectTo: "admin" as const },
    env.SESSION_SECRET,
    STATE_TTL_SECONDS
  );
  // Same reasoning as /api/me/reconnect: reuse the provider already on file
  // so an admin repairing a broken connection isn't switched to a different
  // calendar account behind their back.
  const [existing] = await getLatestConnections([member.id]);
  const url = buildHostedAuthUrl({
    loginHint: normalizeEmail(member.email),
    state,
    provider: asCalendarProvider(existing?.provider),
  });

  return NextResponse.json({ url });
}
