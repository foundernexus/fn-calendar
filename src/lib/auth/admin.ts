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

/** Checks `email` against the ADMIN_EMAILS allowlist (comma-separated env var).
 * This — not `members.role` — is the actual admin authorization mechanism. */
export function isAdminEmail(email: string, adminEmailsEnv: string) {
  const allowlist = adminEmailsEnv
    .split(",")
    .map((e) => normalizeEmail(e))
    .filter(Boolean);
  return allowlist.includes(normalizeEmail(email));
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
  // Re-checking against the live allowlist (not just trusting the signed
  // cookie) means removing someone from ADMIN_EMAILS takes effect on their
  // very next request, not after their cookie's 8h TTL expires.
  if (!isAdminEmail(session.email, env.ADMIN_EMAILS)) return null;
  return session;
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
