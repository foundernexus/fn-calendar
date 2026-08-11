import { NextResponse } from "next/server";
import { ADMIN_COOKIE_NAME } from "@/lib/auth/session";

export async function POST() {
  const res = NextResponse.json({ status: "ok" });
  res.cookies.set(ADMIN_COOKIE_NAME, "", { path: "/", maxAge: 0 });
  return res;
}
