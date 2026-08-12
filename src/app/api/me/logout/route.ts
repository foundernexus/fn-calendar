import { NextResponse } from "next/server";
import { MEMBER_COOKIE_NAME } from "@/lib/auth/session";

// Without this, a member's 90-day session cookie has no way to be cleared —
// on a shared/borrowed browser, the next person to visit /connect would be
// silently redirected straight into the previous member's settings page
// (see the redirect-if-logged-in check in connect/page.tsx).
export async function POST() {
  const res = NextResponse.json({ status: "ok" });
  res.cookies.set(MEMBER_COOKIE_NAME, "", { path: "/", maxAge: 0 });
  return res;
}
