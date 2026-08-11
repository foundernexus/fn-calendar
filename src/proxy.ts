import { NextRequest, NextResponse } from "next/server";
import { verifyValue, TOKEN_PURPOSE, ADMIN_COOKIE_NAME } from "@/lib/auth/session";
import { isAdminEmail } from "@/lib/auth/admin";
import { env } from "@/lib/env";

export const config = {
  matcher: ["/admin/:path*", "/api/admin/:path*"],
};

const PUBLIC_PATHS = new Set(["/admin/login", "/api/admin/login"]);

export async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (PUBLIC_PATHS.has(pathname)) {
    return NextResponse.next();
  }

  const cookie = req.cookies.get(ADMIN_COOKIE_NAME)?.value;
  const session = cookie
    ? await verifyValue<{ email: string }>(TOKEN_PURPOSE.adminSession, cookie, env.SESSION_SECRET)
    : null;

  // Re-check the live allowlist, not just the signed cookie — removing
  // someone from ADMIN_EMAILS should take effect on their next request, not
  // after their cookie's 8h TTL expires.
  if (session && !isAdminEmail(session.email, env.ADMIN_EMAILS)) {
    if (pathname.startsWith("/api/")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    return NextResponse.redirect(new URL("/admin/login", req.url));
  }

  if (!session) {
    if (pathname.startsWith("/api/")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const loginUrl = new URL("/admin/login", req.url);
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
}
