import { cookies } from "next/headers";
import { normalizeEmail } from "@/lib/email";
import { verifyValue, TOKEN_PURPOSE, ADMIN_COOKIE_NAME } from "@/lib/auth/session";
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
