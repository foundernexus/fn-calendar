import { NextResponse } from "next/server";
import { eq, and } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { calendarConnections } from "@/db/schema";
import { requireMemberSession } from "@/lib/auth/member";
import { getLatestConnections, groupConnectionsByMember, isConnectionUsable } from "@/db/queries";
import { signValue, TOKEN_PURPOSE } from "@/lib/auth/session";
import { buildAuthUrl, revokeToken, asCalendarProvider, CALENDAR_PROVIDERS } from "@/lib/calendar";
import { calendarAccessFor } from "@/lib/calendar/access";
import { decryptToken } from "@/lib/calendar/crypto";
import { normalizeEmail } from "@/lib/email";
import { env } from "@/lib/env";

const STATE_TTL_SECONDS = 60 * 10; // matches /api/connect/start

const addSchema = z.object({
  provider: z.enum(CALENDAR_PROVIDERS).default("google"),
  /** Repair this specific calendar instead of attaching a new one. */
  connectionId: z.number().int().positive().optional(),
});

/** Starts connecting an ADDITIONAL calendar for the signed-in member.
 *
 * Also repairs a specific one, when given its connectionId.
 *
 * Two things separate this from /api/connect/start, and both matter:
 *
 * 1. No loginHint when ADDING. The point is to reach a DIFFERENT account than
 *    the one already connected, and a hint would steer the account picker
 *    straight back to it. Repairing is the opposite and hints that calendar.
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
  let provider: (typeof CALENDAR_PROVIDERS)[number] = parsed.success
    ? parsed.data.provider
    : "google";

  // Repairing a specific calendar rather than adding one. The hint has to be
  // THAT calendar's address: hinting anything else sends them to a different
  // account, leaves the broken one broken, and the upsert quietly adds a
  // third. Scoped to the caller's own rows so a guessed id can't be used to
  // probe somebody else's.
  let loginHint = "";
  if (parsed.success && parsed.data.connectionId) {
    const [target] = await db
      .select()
      .from(calendarConnections)
      .where(
        and(
          eq(calendarConnections.id, parsed.data.connectionId),
          eq(calendarConnections.memberId, session.memberId)
        )
      )
      .limit(1);
    if (!target) {
      return NextResponse.json({ error: "That calendar isn't connected." }, { status: 404 });
    }
    loginHint = normalizeEmail(target.grantEmail);
    provider = asCalendarProvider(target.provider);
  }

  const state = await signValue(
    TOKEN_PURPOSE.connectState,
    { memberId: session.memberId, addCalendar: true as const },
    env.SESSION_SECRET,
    STATE_TTL_SECONDS
  );

  return NextResponse.json({
    url: buildAuthUrl({
      loginHint,
      state,
      provider,
      access: await calendarAccessFor(session.member),
    }),
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

  // Searched among ALL of the member's rows, not just the working ones: broken
  // calendars are now listed on /me, so they have a Remove button too, and
  // looking only at usable rows made the one calendar most worth removing the
  // one that 404'd.
  const all =
    groupConnectionsByMember(await getLatestConnections([session.memberId])).get(
      session.memberId
    ) ?? [];
  const usable = all.filter(isConnectionUsable);
  const target = all.find((c) => c.id === parsed.data.connectionId);
  if (!target) {
    return NextResponse.json({ error: "That calendar isn't connected." }, { status: 404 });
  }
  // Only the last WORKING calendar is protected. Removing a broken one leaves
  // nothing worse behind than it already was.
  if (usable.length === 1 && isConnectionUsable(target)) {
    return NextResponse.json(
      {
        error:
          "That's your only calendar. Use Disconnect below if you want to stop being scheduled entirely.",
      },
      { status: 409 }
    );
  }

  // A row with no refresh token is a leftover from the Nylas era — there is
  // nothing of ours to hand back, so removing it is purely local.
  let grantRevokeFailed = false;
  let providerRevocationIncomplete = false;
  if (target.refresh_token_encrypted) {
    try {
      const result = await revokeToken({
        provider: asCalendarProvider(target.provider),
        refreshToken: decryptToken(target.refresh_token_encrypted),
      });
      providerRevocationIncomplete = !result.revokedAtProvider;
    } catch (err) {
      grantRevokeFailed = true;
      console.error("[api/me/calendars] Token revoke failed", {
        memberId: session.memberId,
        connectionId: target.id,
        err,
      });
    }
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
