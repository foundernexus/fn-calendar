import { NextResponse } from "next/server";
import { ADMIN_COOKIE_NAME, MEMBER_COOKIE_NAME } from "@/lib/auth/session";

// Clears BOTH session cookies unconditionally, not just whichever one the
// caller thinks is active. An admin who's also a member (e.g. a facilitator
// connecting their own calendar via /api/admin/connect-calendar) can
// legitimately hold both cookies at once — signing out needs to end both,
// or "Sign out" can silently leave the other session alive.
export async function POST() {
  const res = NextResponse.json({ status: "ok" });
  res.cookies.set(ADMIN_COOKIE_NAME, "", { path: "/", maxAge: 0 });
  res.cookies.set(MEMBER_COOKIE_NAME, "", { path: "/", maxAge: 0 });
  return res;
}
