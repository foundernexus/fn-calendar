import { NextRequest, NextResponse } from "next/server";
import {
  verifyValue,
  TOKEN_PURPOSE,
  ADMIN_COOKIE_NAME,
  MEMBER_COOKIE_NAME,
} from "@/lib/auth/session";
import { env } from "@/lib/env";

export const config = {
  matcher: [
    "/admin/:path*",
    "/api/admin/:path*",
    "/me/:path*",
    "/api/me/:path*",
    // /advisor needs the same member session as /me — the advisor-only check
    // (isAdvisor) happens in the page itself, since it needs a DB read that
    // this cookie-only middleware deliberately avoids.
    "/advisor/:path*",
  ],
};

// /api/admin/login no longer exists (deleted — same bare-email vulnerability
// as the old /api/connect/start fast path, see /api/nylas/callback for the
// real admin-verification logic). /admin/login stays as a bookmark safety
// net that just redirects to /connect — never links anywhere itself.
const PUBLIC_PATHS = new Set(["/admin/login"]);

export async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;

  if (
    pathname.startsWith("/me") ||
    pathname.startsWith("/api/me") ||
    pathname.startsWith("/advisor")
  ) {
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

  // Deliberately only checks that a valid, unexpired admin cookie exists —
  // NOT whether that person still holds admin. Admin can now come from the
  // Team flag on the People page as well as ADMIN_EMAILS (see hasAdminAccess),
  // and answering that needs a database read, which middleware runs on every
  // single request and shouldn't.
  //
  // The live check lives in requireAdminSession instead, which every admin
  // page and every admin route handler calls first. Someone whose access was
  // just revoked still gets past this line and is then turned away there —
  // they reach no data either way.
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
