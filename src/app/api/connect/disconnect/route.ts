import { NextResponse } from "next/server";
import { eq, and } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { calendarConnections } from "@/db/schema";
import { getMemberByEmail } from "@/db/queries";

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

  const member = await getMemberByEmail(parsed.data.email);
  if (!member) {
    return NextResponse.json({ error: "No matching member found." }, { status: 404 });
  }

  // Local flag only — does NOT call Nylas to revoke the real OAuth grant.
  // Revokes every currently-connected row for this member (not just the most
  // recent), in case more than one is somehow active at once.
  await db
    .update(calendarConnections)
    .set({ connectionStatus: "revoked", revokedAt: new Date() })
    .where(
      and(
        eq(calendarConnections.memberId, member.id),
        eq(calendarConnections.connectionStatus, "connected")
      )
    );

  return NextResponse.json({ status: "revoked" });
}
