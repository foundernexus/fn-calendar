import { NextResponse } from "next/server";
import { z } from "zod";
import { isAdminEmail, setAdminSessionCookie } from "@/lib/auth/admin";
import { env } from "@/lib/env";

const bodySchema = z.object({ email: z.string().email() });

// No longer reachable from any UI (the shared /connect form now handles
// admin sign-in), kept only so the old bookmark-safety-net /admin/login
// page's underlying API isn't a dead file — same trust model as before.
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

  const res = NextResponse.json({ status: "ok" });
  await setAdminSessionCookie(res, parsed.data.email);
  return res;
}
