import { NextResponse } from "next/server";
import { z } from "zod";
import { getMemberByEmail, getActiveConnections } from "@/db/queries";
import { signValue, TOKEN_PURPOSE } from "@/lib/auth/session";
import { isAdminEmail, setAdminSessionCookie } from "@/lib/auth/admin";
import { buildHostedAuthUrl } from "@/lib/nylas";
import { normalizeEmail } from "@/lib/email";
import { env } from "@/lib/env";

const bodySchema = z.object({ email: z.string().email() });

const STATE_TTL_SECONDS = 60 * 10; // 10 minutes — just long enough for the OAuth round trip

/** The single shared sign-in entry point for everyone — admins and members
 * type their email into the same form (src/components/connect-form.tsx).
 *
 * An admin email always gets an admin session. If they're also a member
 * (a facilitator — e.g. Tobias, Karin) without a currently-connected
 * calendar, they go through the SAME Nylas hosted-auth flow a guest would,
 * just tagged with `redirectTo: "admin"` in the state token so
 * /api/nylas/callback sends them to the admin dashboard afterward instead
 * of /me. Already-connected admins (or admins with no member row at all —
 * nothing to connect) skip straight to the dashboard. Anyone who isn't an
 * admin falls through to the plain member calendar-connect flow below. */
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
    const member = await getMemberByEmail(parsed.data.email);
    const activeConnections = member ? await getActiveConnections([member.id]) : [];

    if (member && activeConnections.length === 0) {
      const state = await signValue(
        TOKEN_PURPOSE.connectState,
        { memberId: member.id, redirectTo: "admin" as const },
        env.SESSION_SECRET,
        STATE_TTL_SECONDS
      );
      const url = buildHostedAuthUrl({
        loginHint: normalizeEmail(member.email),
        state,
      });
      const res = NextResponse.json({ url });
      await setAdminSessionCookie(res, parsed.data.email);
      return res;
    }

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
