import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/db";
import { members } from "@/db/schema";
import { getMemberByEmail } from "@/db/queries";
import { requireAdminSession } from "@/lib/auth/admin";
import { normalizeEmail } from "@/lib/email";

const bodySchema = z.object({
  fullName: z.string().trim().min(1, "Enter a name.").max(200),
  email: z.string().trim().email("Enter a valid email address."),
  // Marks them as an advisor: they show up in find-a-time's Advisor picker
  // instead of the guest picker, and /connect lands them on /advisor. Defaults
  // false so the existing "add guest" call keeps its old behaviour untouched.
  isAdvisor: z.boolean().default(false),
  // Marks them as FounderNexus staff who run sessions — gates the Session lead
  // picker. Same defaulting reason as isAdvisor. Neither flag grants admin
  // access; that stays ADMIN_EMAILS-only.
  isFacilitator: z.boolean().default(false),
});

/** drizzle-orm wraps every driver error in `DrizzleQueryError`, which has no
 * `code` of its own — the real Postgres error (with `code: "23505"` for a
 * unique violation) is on `.cause`. Same pattern as api/admin/events/route.ts. */
function isUniqueViolation(err: unknown): boolean {
  let e = err as { code?: unknown; cause?: unknown } | undefined;
  for (let depth = 0; e && depth < 10; depth++) {
    if (e.code === "23505") return true;
    e = e.cause as typeof e;
  }
  return false;
}

/** Registers a new member so they can sign in at /connect — there's no email
 * invite system (deliberately out of scope), so this is the whole "invite" a
 * guest gets: an admin creates their row here, then tells them out of band
 * (Slack, text, whatever) to go connect their calendar. They stay
 * "not connected" — and so invisible to the find-a-time guest picker, which
 * only lists connected members — until they actually do. */
export async function POST(request: Request) {
  const session = await requireAdminSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid request." },
      { status: 400 }
    );
  }

  const email = normalizeEmail(parsed.data.email);
  const existing = await getMemberByEmail(email);
  if (existing) {
    return NextResponse.json(
      { error: `${existing.fullName} is already registered with that email.` },
      { status: 409 }
    );
  }

  try {
    const [created] = await db
      .insert(members)
      .values({
        email,
        fullName: parsed.data.fullName.trim(),
        isAdvisor: parsed.data.isAdvisor,
        isFacilitator: parsed.data.isFacilitator,
      })
      .returning();
    return NextResponse.json({ member: created });
  } catch (err) {
    if (isUniqueViolation(err)) {
      return NextResponse.json(
        { error: "Someone with that email is already registered." },
        { status: 409 }
      );
    }
    console.error("[api/admin/members] Create failed", err);
    return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 });
  }
}
