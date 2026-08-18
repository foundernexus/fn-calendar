import { NextResponse } from "next/server";
import { eq, and } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { calendarConnections } from "@/db/schema";
import { requireMemberSession } from "@/lib/auth/member";
import { getActiveConnections, groupConnectionsByMember } from "@/db/queries";
import { signValue, TOKEN_PURPOSE } from "@/lib/auth/session";
import { buildHostedAuthUrl, revokeNylasGrant, CALENDAR_PROVIDERS } from "@/lib/nylas";
import { env } from "@/lib/env";

const STATE_TTL_SECONDS = 60 * 10; // matches /api/connect/start

const addSchema = z.object({
  provider: z.enum(CALENDAR_PROVIDERS).default("google"),
});

/** Starts connecting an ADDITIONAL calendar for the signed-in member.
 *
 * Two things separate this from /api/connect/start, and both matter:
 *
 * 1. No loginHint. The whole point is to reach a DIFFERENT account than the one
 *    already connected, and a hint would steer the provider's account picker
 *    straight back to the existing one.
 *
 * 2. The state token carries `addCalendar`. The callback normally insists the
 *    account signed into matches the member's registered address (or one
 *    already linked to them) — that check is what stops a stranger who knows an
 *    email from binding their own calendar to somebody else's account. A second
 *    calendar is a legitimate exception, and it's safe here precisely because
 *    this route runs behind requireMemberSession: the token is only ever minted
 *    for someone already proven to be that member, and it's HMAC-signed so the
 *    flag can't be added from outside. */
export async function POST(request: Request) {
  const session = await requireMemberSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let json: unknown = {};
  try {
    json = await request.json();
  } catch {
    // Body is optional — an older client sending nothing gets google.
  }
  const parsed = addSchema.safeParse(json ?? {});
  const provider = parsed.success ? parsed.data.provider : "google";

  const state = await signValue(
    TOKEN_PURPOSE.connectState,
    { memberId: session.memberId, addCalendar: true as const },
    env.SESSION_SECRET,
    STATE_TTL_SECONDS
  );

  return NextResponse.json({
    url: buildHostedAuthUrl({ loginHint: "", state, provider }),
  });
}

const targetSchema = z.object({ connectionId: z.number().int().positive() });

/** Chooses which of the member's calendars receives new sessions.
 *
 * Availability is read from all of them; only this one is written to. Done as
 * a batch so the old target is cleared and the new one set together — the
 * partial unique index would reject the intermediate state where two rows
 * claim it, which is exactly the protection wanted. */
export async function PATCH(request: Request) {
  const session = await requireMemberSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  const parsed = targetSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: "Pick a calendar." }, { status: 400 });
  }

  // Scoped to the caller's own member id, so a guessed connection id can't
  // repoint somebody else's invites.
  const owned = await db
    .select()
    .from(calendarConnections)
    .where(
      and(
        eq(calendarConnections.id, parsed.data.connectionId),
        eq(calendarConnections.memberId, session.memberId)
      )
    )
    .limit(1);
  if (owned.length === 0) {
    return NextResponse.json({ error: "That calendar isn't connected." }, { status: 404 });
  }

  try {
    await db.batch([
      db
        .update(calendarConnections)
        .set({ isPrimary: false })
        .where(eq(calendarConnections.memberId, session.memberId)),
      db
        .update(calendarConnections)
        .set({ isPrimary: true })
        .where(eq(calendarConnections.id, parsed.data.connectionId)),
    ]);
  } catch (err) {
    console.error("[api/me/calendars] Setting the invite target failed", {
      memberId: session.memberId,
      err,
    });
    return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}

/** Disconnects ONE calendar, revoking its grant at Nylas as well as marking the
 * row revoked — leaving the grant alive would keep Nylas reading that calendar
 * and keep it counting against the plan's allowance.
 *
 * Refuses to remove the last one: a member with no calendar can't be scheduled
 * at all, and silently making themselves invisible from a per-row delete button
 * is not something to allow by accident. Disconnecting entirely stays the
 * separate, clearly-labelled action. */
export async function DELETE(request: Request) {
  const session = await requireMemberSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  const parsed = targetSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: "Pick a calendar." }, { status: 400 });
  }

  const usable = groupConnectionsByMember(await getActiveConnections([session.memberId])).get(
    session.memberId
  ) ?? [];
  const target = usable.find((c) => c.id === parsed.data.connectionId);
  if (!target) {
    return NextResponse.json({ error: "That calendar isn't connected." }, { status: 404 });
  }
  if (usable.length === 1) {
    return NextResponse.json(
      {
        error:
          "That's your only calendar. Use Disconnect below if you want to stop being scheduled entirely.",
      },
      { status: 409 }
    );
  }

  let grantRevokeFailed = false;
  try {
    await revokeNylasGrant(target.nylas_grant_id);
  } catch (err) {
    grantRevokeFailed = true;
    console.error("[api/me/calendars] Grant revoke failed", {
      memberId: session.memberId,
      grantId: target.nylas_grant_id,
      err,
    });
  }

  try {
    await db
      .update(calendarConnections)
      .set({ connectionStatus: "revoked", revokedAt: new Date(), isPrimary: false })
      .where(eq(calendarConnections.id, target.id));
  } catch (err) {
    console.error("[api/me/calendars] Marking the row revoked failed", {
      memberId: session.memberId,
      err,
    });
    return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 });
  }

  return NextResponse.json({ ok: true, grantRevokeFailed });
}
