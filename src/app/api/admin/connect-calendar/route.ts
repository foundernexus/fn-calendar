import { NextResponse } from "next/server";
import { getMemberByEmail } from "@/db/queries";
import { requireAdminSession } from "@/lib/auth/admin";
import { signValue, TOKEN_PURPOSE } from "@/lib/auth/session";
import { buildHostedAuthUrl } from "@/lib/nylas";
import { normalizeEmail } from "@/lib/email";
import { env } from "@/lib/env";

const STATE_TTL_SECONDS = 60 * 10; // matches /api/connect/start

/** The shared /connect form always routes an admin email straight to the
 * admin dashboard — which means an admin who's ALSO a member (e.g. Tobias
 * and Karin, who lead sessions as facilitators and need their own connected
 * calendar) has no way to reach the calendar-connect flow through that form.
 * This is their way back in: same Nylas hosted-auth flow as the member
 * path, just entered from inside the admin area using their own registered
 * email instead of one typed into a form. */
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
    { memberId: member.id },
    env.SESSION_SECRET,
    STATE_TTL_SECONDS
  );
  const url = buildHostedAuthUrl({
    loginHint: normalizeEmail(member.email),
    state,
  });

  return NextResponse.json({ url });
}
