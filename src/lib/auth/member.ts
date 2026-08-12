import { cookies } from "next/headers";
import { verifyValue, TOKEN_PURPOSE, MEMBER_COOKIE_NAME } from "@/lib/auth/session";
import { getMemberById } from "@/db/queries";
import { env } from "@/lib/env";

/** Re-checks the member session cookie from inside a Server Component or
 * Route Handler. `proxy.ts` already blocks unauthenticated requests to /me/*
 * and /api/me/*, but per the same reasoning already applied to
 * `requireAdminSession`, don't rely on Proxy alone.
 *
 * Unlike admin (whose defense-in-depth check is a cheap re-check against the
 * ADMIN_EMAILS allowlist), there's no member-side allowlist — being a row in
 * `members` is the only membership requirement. So the equivalent check here
 * is re-fetching that row: with a 90-day cookie TTL, a member deleted from
 * the table would otherwise keep a working settings page for up to 90 days.
 * Returns `{ memberId, member }` (not just the raw payload) so callers don't
 * have to redo the lookup — or `null` if there isn't a valid session. */
export async function requireMemberSession() {
  const cookieStore = await cookies();
  const cookie = cookieStore.get(MEMBER_COOKIE_NAME)?.value;
  if (!cookie) return null;
  const session = await verifyValue<{ memberId: number }>(
    TOKEN_PURPOSE.memberSession,
    cookie,
    env.SESSION_SECRET
  );
  if (!session || typeof session.memberId !== "number") return null;
  const member = await getMemberById(session.memberId);
  if (!member) return null;
  return { memberId: member.id, member };
}
