import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { normalizeEmail } from "@/lib/email";
import {
  signValue,
  verifyValue,
  TOKEN_PURPOSE,
  ADMIN_COOKIE_NAME,
  ADMIN_SESSION_TTL_SECONDS,
} from "@/lib/auth/session";
import { env } from "@/lib/env";
import { getMemberByEmail } from "@/db/queries";

/** Checks `email` against the ADMIN_EMAILS allowlist (comma-separated env var).
 * One of the two ways to hold admin — see hasAdminAccess for the other. */
export function isAdminEmail(email: string, adminEmailsEnv: string) {
  const allowlist = adminEmailsEnv
    .split(",")
    .map((e) => normalizeEmail(e))
    .filter(Boolean);
  return allowlist.includes(normalizeEmail(email));
}

/** The authoritative "may this person use the admin area" question.
 *
 * Two ways in, and the second is deliberate: FounderNexus staff marked as Team
 * on the People page get the admin area too. Being Team means running sessions,
 * and running sessions IS the admin area — Schedule and People are the whole
 * tool. Gating that behind a Vercel env var meant every new colleague needed a
 * deploy, and that var is write-only, which is how Karin was silently dropped
 * from it once already.
 *
 * The consequence is real and worth stating: marking someone Team gives them
 * everything an admin can do, including removing people and cancelling any
 * session. `members.role` remains unused for authorization.
 *
 * ADMIN_EMAILS stays as the bootstrap. Someone has to be able to reach the
 * People page to mark the first colleague as Team, and that can't itself
 * depend on being marked Team. */
export async function hasAdminAccess(email: string) {
  if (isAdminEmail(email, env.ADMIN_EMAILS)) return true;
  const member = await getMemberByEmail(email);
  return !!member?.isFacilitator;
}

/** Where someone's admin access comes from, because the two aren't equal.
 *
 * `owner` is the ADMIN_EMAILS allowlist — an env var only someone with Vercel
 * access can change. `team` is the Team flag, which any owner can grant from
 * the People page.
 *
 * Everything about running sessions is open to both: searching, booking,
 * cancelling, rescheduling, adding founders and advisors. A Team member who
 * couldn't cancel the session they're about to run would be unable to do their
 * job. Two things are owner-only, and both for the same reason — they're the
 * actions you can't take back or that hand out access:
 *
 *   - removing a person, which revokes their calendar and is irreversible
 *   - marking someone as Team, which is granting admin
 *
 * Returns null for anyone with no admin access at all. */
export async function resolveAdminTier(email: string): Promise<"owner" | "team" | null> {
  if (isAdminEmail(email, env.ADMIN_EMAILS)) return "owner";
  const member = await getMemberByEmail(email);
  return member?.isFacilitator ? "team" : null;
}

/** Re-checks the admin session cookie from inside a Server Component or Route
 * Handler. `proxy.ts` already blocks unauthenticated requests to /admin/* and
 * /api/admin/*, but Next's own guidance is not to rely on Proxy alone (a
 * matcher edit or a route moved out from under it silently removes that
 * protection) — call this in every admin page/route as defense-in-depth.
 * Returns the session payload, or null if there isn't a valid one. */
export async function requireAdminSession() {
  const cookieStore = await cookies();
  const cookie = cookieStore.get(ADMIN_COOKIE_NAME)?.value;
  if (!cookie) return null;
  const session = await verifyValue<{ email: string }>(
    TOKEN_PURPOSE.adminSession,
    cookie,
    env.SESSION_SECRET
  );
  if (!session) return null;
  // Re-checked live on every request rather than trusted from the signed
  // cookie: removing someone from ADMIN_EMAILS, or clearing their Team flag on
  // the People page, takes effect on their very next request instead of
  // whenever their 8h cookie happens to expire.
  //
  // This is now the ONLY place that live check happens — proxy.ts can't do it,
  // since answering it needs a database read and middleware runs on every
  // request. That's why this function is called at the top of every admin page
  // and every admin route handler, not merely as belt-and-braces.
  const tier = await resolveAdminTier(session.email);
  if (!tier) return null;
  // Callers that gate an owner-only action check `tier`; everything else just
  // checks the session exists, exactly as before.
  return { ...session, tier };
}

/** Signs an admin session and sets it on `res`. Called from exactly one
 * place — /api/nylas/callback, and only after verifying the OAuth-authenticated
 * email matches the admin's registered address — so no other code path can
 * mint an admin session from an unverified email string. */
export async function setAdminSessionCookie(res: NextResponse, email: string) {
  const token = await signValue(
    TOKEN_PURPOSE.adminSession,
    { email: normalizeEmail(email) },
    env.SESSION_SECRET,
    ADMIN_SESSION_TTL_SECONDS
  );
  res.cookies.set(ADMIN_COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: ADMIN_SESSION_TTL_SECONDS,
    path: "/",
  });
}
