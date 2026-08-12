import { NextResponse } from "next/server";
import { z } from "zod";
import { getMemberByEmail } from "@/db/queries";
import { signValue, TOKEN_PURPOSE } from "@/lib/auth/session";
import { isAdminEmail, setAdminSessionCookie } from "@/lib/auth/admin";
import { buildHostedAuthUrl } from "@/lib/nylas";
import { normalizeEmail } from "@/lib/email";
import { env } from "@/lib/env";

const bodySchema = z.object({ email: z.string().email() });

const STATE_TTL_SECONDS = 60 * 10; // 10 minutes — just long enough for the OAuth round trip

/** The single shared sign-in entry point for everyone — admins and members
 * type their email into the same form (src/components/connect-form.tsx).
 * An admin email short-circuits straight to an admin session; anyone else
 * falls through to the member calendar-connect flow below.
 *
 * Note this means an email that's BOTH an admin and a member (e.g. a
 * facilitator who's also an admin) always lands in the admin dashboard from
 * THIS form — that's the intended behavior. If they've never connected a
 * calendar, or need to reconnect, they can't get there through this form at
 * all (it always wins to admin) — see /api/admin/connect-calendar for the
 * admin-only path back into the calendar-connect flow for their own email. */
export async function POST(request: Request) {
  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return NextResponse.json({ error: "Enter a valid email address." }, { status: 400 });
  }

  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: "Enter a valid email address." }, { status: 400 });
  }

  if (isAdminEmail(parsed.data.email, env.ADMIN_EMAILS)) {
    const res = NextResponse.json({ redirect: "/admin/find-a-time" });
    await setAdminSessionCookie(res, parsed.data.email);
    return res;
  }

  const member = await getMemberByEmail(parsed.data.email);
  if (!member) {
    return NextResponse.json(
      { error: "No matching member found. Contact an admin to be added." },
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
