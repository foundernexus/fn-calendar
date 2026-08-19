import { NextResponse } from "next/server";
import { z } from "zod";
import { getMemberByEmail } from "@/db/queries";
import { signValue, TOKEN_PURPOSE } from "@/lib/auth/session";
import { hasAdminAccess } from "@/lib/auth/admin";
import { buildAuthUrl, CALENDAR_PROVIDERS } from "@/lib/calendar";
import { normalizeEmail } from "@/lib/email";
import { env } from "@/lib/env";

// `provider` defaults to google rather than being required, so any older
// client still in a member's open tab keeps working instead of 400-ing.
const bodySchema = z.object({
  email: z.string().email(),
  provider: z.enum(CALENDAR_PROVIDERS).default("google"),
});

const STATE_TTL_SECONDS = 60 * 10; // 10 minutes — just long enough for the OAuth round trip

/** The single shared sign-in entry point for everyone — admins and members
 * type their email into the same form (src/components/connect-form.tsx).
 *
 * An admin email is NEVER trusted on its own — typing the string is not
 * proof you own that inbox. Every admin login (first time or the hundredth)
 * goes through the same real Nylas OAuth round trip a guest would, tagged
 * `redirectTo: "admin"` in the state token. The admin session itself is only
 * ever minted in /api/nylas/callback, and only after confirming the
 * Google/Microsoft account actually signed into matches this member's
 * registered email exactly — see the callback for that check. This route
 * only decides which state-token tag to use; it grants nothing by itself. */
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

  // hasAdminAccess, not isAdminEmail: staff marked as Team on the People page
  // hold admin too, and have to be routed down the admin branch or they'd land
  // on /me with no way to reach Schedule or People.
  if (await hasAdminAccess(parsed.data.email)) {
    const member = await getMemberByEmail(parsed.data.email);
    if (!member) {
      return NextResponse.json(
        {
          error:
            "Your admin email isn't registered as a member, so there's no calendar to verify against. Ask another admin to add you as a member first.",
        },
        { status: 404 }
      );
    }

    const state = await signValue(
      TOKEN_PURPOSE.connectState,
      { memberId: member.id, redirectTo: "admin" as const },
      env.SESSION_SECRET,
      STATE_TTL_SECONDS
    );
    const url = buildAuthUrl({
      loginHint: normalizeEmail(member.email),
      state,
      provider: parsed.data.provider,
    });
    return NextResponse.json({ url });
  }

  const member = await getMemberByEmail(parsed.data.email);
  if (!member) {
    // Worth being straight about what this does and doesn't achieve: the
    // wording no longer confirms whether an address is registered, but a known
    // one still gets a redirect URL and an unknown one still gets an error, so
    // the difference remains observable to anyone probing deliberately. It
    // can't be closed here — issuing a working auth URL for an address we
    // don't recognise isn't possible.
    //
    // The control that actually matters is rate limiting at the edge, which
    // this endpoint has none of (nothing in the codebase does). It is public,
    // unauthenticated, takes an arbitrary email, and each call reaches Nylas.
    // See the audit notes: add a Vercel Firewall rate-limit rule on this path.
    return NextResponse.json(
      { error: "We couldn't start sign-in for that address. Check it, or ask an admin to add you." },
      { status: 404 }
    );
  }

  const state = await signValue(
    TOKEN_PURPOSE.connectState,
    { memberId: member.id },
    env.SESSION_SECRET,
    STATE_TTL_SECONDS
  );
  const url = buildAuthUrl({
    loginHint: normalizeEmail(member.email),
    state,
    provider: parsed.data.provider,
  });

  return NextResponse.json({ url });
}
