import { NextResponse } from "next/server";
import { getMemberByEmail, getLatestConnections, pickInviteConnection } from "@/db/queries";
import { requireAdminSession } from "@/lib/auth/admin";
import { signValue, TOKEN_PURPOSE } from "@/lib/auth/session";
import { asCalendarProvider, buildAuthUrl } from "@/lib/calendar";
import { calendarAccessFor } from "@/lib/calendar/access";
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
    // addCalendar marks this as a repair started from an existing admin
    // session rather than a login — see the callback for why that distinction
    // decides whether the registered address is demanded.
    { memberId: member.id, redirectTo: "admin" as const, addCalendar: true as const },
    env.SESSION_SECRET,
    STATE_TTL_SECONDS
  );
  // Same reasoning as /api/me/reconnect: reuse the provider already on file
  // so an admin repairing a broken connection isn't switched to a different
  // calendar account behind their back.
  // Same reasoning as /api/me/reconnect: one row per calendar now, so the
  // first is not necessarily the one they actually use.
  const existing = pickInviteConnection(await getLatestConnections([member.id]));
  const url = buildAuthUrl({
    // Same as /api/me/reconnect: hint the calendar being repaired, not the
    // registered address, or a mismatch between the two adds a second
    // calendar instead of fixing the first.
    //
    // One extra constraint here that doesn't apply there: an ADMIN session is
    // only ever minted for the registered address (see the callback), so an
    // admin whose calendar sits under a different address gets their calendar
    // repaired but stays on their existing admin session rather than being
    // re-granted one. That's correct — this button connects a calendar, it
    // isn't a login.
    loginHint: normalizeEmail(existing?.grant_email ?? member.email),
    state,
    provider: asCalendarProvider(existing?.provider),
    access: await calendarAccessFor(member),
  });

  return NextResponse.json({ url });
}
