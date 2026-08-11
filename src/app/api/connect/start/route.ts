import { NextResponse } from "next/server";
import { z } from "zod";
import { getMemberByEmail } from "@/db/queries";
import { signValue, TOKEN_PURPOSE } from "@/lib/auth/session";
import { buildHostedAuthUrl } from "@/lib/nylas";
import { normalizeEmail } from "@/lib/email";
import { env } from "@/lib/env";

const bodySchema = z.object({ email: z.string().email() });

const STATE_TTL_SECONDS = 60 * 10; // 10 minutes — just long enough for the OAuth round trip

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

  const member = await getMemberByEmail(parsed.data.email);
  if (!member) {
    return NextResponse.json(
      { error: "No matching member found. Contact an admin to be added." },
      { status: 404 }
    );
  }

  const state = await signValue(
    TOKEN_PURPOSE.connectState,
    { memberId: member.id },
    env.SESSION_SECRET,
    STATE_TTL_SECONDS
  );
  const url = buildHostedAuthUrl({
    loginHint: normalizeEmail(member.email),
    state,
  });

  return NextResponse.json({ url });
}
