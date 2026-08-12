import { NextRequest, NextResponse } from "next/server";
import {
  verifyValue,
  TOKEN_PURPOSE,
  ADMIN_COOKIE_NAME,
  MEMBER_COOKIE_NAME,
} from "@/lib/auth/session";
import { isAdminEmail } from "@/lib/auth/admin";
import { env } from "@/lib/env";

export const config = {
  matcher: ["/admin/:path*", "/api/admin/:path*", "/me/:path*", "/api/me/:path*"],
};

const PUBLIC_PATHS = new Set(["/admin/login", "/api/admin/login"]);

export async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;

  if (pathname.startsWith("/me") || pathname.startsWith("/api/me")) {
    return handleMemberRoute(req);
  }
  return handleAdminRoute(req);
}

async function handleAdminRoute(req: NextRequest) {
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
    return NextResponse.redirect(new URL("/connect", req.url));
  }

  if (!session) {
    if (pathname.startsWith("/api/")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    // /admin/login itself just redirects to /connect now (it's no longer
    // linked from anywhere, kept only as a bookmark safety net) — go
    // straight there instead of bouncing through it.
    return NextResponse.redirect(new URL("/connect", req.url));
  }

  return NextResponse.next();
}

// Cookie-only check, no DB call — mirrors the admin path's cheap allowlist
// check rather than doing per-request DB work in middleware. The deeper
// check (does this member row still exist?) is `requireMemberSession()`'s
// job, called per-page/route as defense-in-depth, same reasoning already
// applied on the admin side.
async function handleMemberRoute(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const cookie = req.cookies.get(MEMBER_COOKIE_NAME)?.value;
  const session = cookie
    ? await verifyValue<{ memberId: number }>(TOKEN_PURPOSE.memberSession, cookie, env.SESSION_SECRET)
    : null;

  if (!session) {
    if (pathname.startsWith("/api/")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    // There's no separate member login page — logging in IS connecting a
    // calendar, so an unauthenticated visit goes back to the start of that
    // flow, not to a login form that doesn't exist.
    return NextResponse.redirect(new URL("/connect", req.url));
  }

  return NextResponse.next();
}
