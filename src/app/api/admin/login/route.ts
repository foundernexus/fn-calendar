import { NextResponse } from "next/server";
import { z } from "zod";
import {
  signValue,
  TOKEN_PURPOSE,
  ADMIN_COOKIE_NAME,
  ADMIN_SESSION_TTL_SECONDS,
} from "@/lib/auth/session";
import { isAdminEmail } from "@/lib/auth/admin";
import { normalizeEmail } from "@/lib/email";
import { env } from "@/lib/env";

const bodySchema = z.object({ email: z.string().email() });

export async function POST(request: Request) {
  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return NextResponse.json({ error: "Enter a valid email address." }, { status: 400 });
  }

  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: "Enter a valid email address." }, { status: 400 });
  }

  if (!isAdminEmail(parsed.data.email, env.ADMIN_EMAILS)) {
    return NextResponse.json({ error: "Not an admin email." }, { status: 403 });
  }

  const token = await signValue(
    TOKEN_PURPOSE.adminSession,
    { email: normalizeEmail(parsed.data.email) },
    env.SESSION_SECRET,
    ADMIN_SESSION_TTL_SECONDS
  );

  const res = NextResponse.json({ status: "ok" });
  res.cookies.set(ADMIN_COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: ADMIN_SESSION_TTL_SECONDS,
    path: "/",
  });
  return res;
}
