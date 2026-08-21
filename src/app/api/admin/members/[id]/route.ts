import { NextResponse } from "next/server";
import { z } from "zod";
import { eq, or, and, sql as raw } from "drizzle-orm";
import { db } from "@/db";
import { members, events, eventAttendees, calendarConnections } from "@/db/schema";
import { requireAdminSession, isAdminEmail } from "@/lib/auth/admin";
import { revokeNylasGrant } from "@/lib/nylas";
import { revokeToken, asCalendarProvider } from "@/lib/calendar";
import { decryptToken } from "@/lib/calendar/crypto";
import { env } from "@/lib/env";

const editSchema = z.object({
  fullName: z.string().trim().min(1, "Enter a name.").max(200),
  // Optional so a rename doesn't have to restate the role, and so a client that
  // only knows how to edit names keeps working.
  isAdvisor: z.boolean().optional(),
  isFacilitator: z.boolean().optional(),
});

/** Corrects a person's name or role.
 *
 * Email is deliberately NOT editable here. It is the join between this row and
 * everything else about them: the address they sign in with, the one the
 * callback matches an OAuth account against, and the fallback an invitation is
 * sent to. Changing it would leave a connected calendar bound to an address the
 * member no longer has, and they would silently stop being recognised at
 * sign-in. Somebody with the wrong address needs removing and re-adding, which
 * is a different, deliberately heavier action.
 *
 * Renaming is open to any admin. Changing the Team flag is owner-only, for the
 * same reason granting it at creation is: it hands out admin access. Advisor is
 * a routing label, not a permission, so it isn't restricted. */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireAdminSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const memberId = Number((await params).id);
  if (!Number.isInteger(memberId) || memberId <= 0) {
    return NextResponse.json({ error: "Invalid member id." }, { status: 400 });
  }

  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  const parsed = editSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid request." },
      { status: 400 }
    );
  }
  const body = parsed.data;

  let current;
  try {
    [current] = await db.select().from(members).where(eq(members.id, memberId)).limit(1);
  } catch (err) {
    console.error("[admin/members/:id] Edit lookup failed", { memberId, err });
    return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 });
  }
  if (!current) {
    return NextResponse.json({ error: "That person no longer exists." }, { status: 404 });
  }

  // Only when it actually CHANGES — a Team admin renaming a colleague who is
  // already Team shouldn't be refused for leaving the flag as it was.
  const changesTeamFlag =
    body.isFacilitator !== undefined && body.isFacilitator !== current.isFacilitator;
  if (changesTeamFlag && session.tier !== "owner") {
    return NextResponse.json(
      { error: "Only an account owner can change who's on the team." },
      { status: 403 }
    );
  }

  try {
    const [updated] = await db
      .update(members)
      .set({
        fullName: body.fullName,
        ...(body.isAdvisor === undefined ? {} : { isAdvisor: body.isAdvisor }),
        ...(body.isFacilitator === undefined ? {} : { isFacilitator: body.isFacilitator }),
      })
      .where(eq(members.id, memberId))
      .returning();
    return NextResponse.json({ member: updated });
  } catch (err) {
    console.error("[admin/members/:id] Edit failed", { memberId, err });
    return NextResponse.json({ error: "Couldn't save the changes. Please try again." }, { status: 500 });
  }
}

/** Removes a member for good: revokes their calendar grant at Nylas, then
 * deletes the row (their connections and stated availability cascade with it).
 *
 * Deliberately refuses when the member is in a CONFIRMED session. Those rows
 * are the record of meetings that really happened, and quietly destroying them
 * to tidy up a roster is not a trade an admin should be able to make by
 * clicking "Remove". Someone with real session history needs archiving, which
 * is a different feature.
 *
 * Cancelled sessions don't block, and are cleaned up as part of the removal —
 * they never happened, so there's no history to protect, and blocking on them
 * meant an admin saw an empty grid while being told the person was in two
 * sessions they had no way to find.
 *
 * That leaves this squarely aimed at what it's for: people added by mistake,
 * duplicates, wrong addresses, and anyone who never connected at all. */
export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireAdminSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Owner-only. Removing someone revokes their calendar and deletes their row;
  // there's no undo, and it's the one admin action whose damage can't be
  // repaired from inside the app. Team can do everything else.
  if (session.tier !== "owner") {
    return NextResponse.json(
      { error: "Only an account owner can remove people. Ask them to do it." },
      { status: 403 }
    );
  }

  const memberId = Number((await params).id);
  if (!Number.isInteger(memberId) || memberId <= 0) {
    return NextResponse.json({ error: "Invalid member id." }, { status: 400 });
  }

  let member;
  try {
    [member] = await db.select().from(members).where(eq(members.id, memberId)).limit(1);
  } catch (err) {
    console.error("[admin/members/:id] Lookup failed", { memberId, err });
    return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 });
  }

  if (!member) {
    // Already gone — treat as success so a double click or a stale page
    // doesn't produce an alarming error about the desired end state.
    return NextResponse.json({ alreadyRemoved: true });
  }

  // Deliberately isAdminEmail, not hasAdminAccess. Removing someone whose
  // admin comes from the Team flag is fine — the flag lives on the row being
  // deleted, so they simply stop being staff, which is exactly what removing
  // them means. Removing someone on the ADMIN_EMAILS allowlist is different:
  // the allowlist is an env var that outlives the row, leaving them still an
  // admin but with no member row to verify a calendar against, so sign-in
  // fails with a message that explains nothing.
  if (isAdminEmail(member.email, env.ADMIN_EMAILS)) {
    return NextResponse.json(
      {
        error:
          "That's an admin account. Remove the address from ADMIN_EMAILS first, or they'll be locked out of signing in.",
      },
      { status: 409 }
    );
  }

  // CONFIRMED only. This guard exists to stop a roster tidy-up destroying the
  // record of meetings that really happened — and a cancelled session never
  // happened. Counting those too produced the worst possible message: the grid
  // correctly showed nothing (it only renders confirmed sessions) while this
  // insisted the person was in two, naming rows nobody could see or reach.
  let sessionCount = 0;
  try {
    const [{ count }] = await db
      .select({ count: raw<number>`count(*)::int` })
      .from(events)
      .leftJoin(eventAttendees, eq(eventAttendees.eventId, events.id))
      .where(
        and(
          eq(events.status, "confirmed"),
          or(eq(events.organizerMemberId, memberId), eq(eventAttendees.memberId, memberId))
        )
      );
    sessionCount = count;
  } catch (err) {
    console.error("[admin/members/:id] Session count failed", { memberId, err });
    return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 });
  }

  if (sessionCount > 0) {
    return NextResponse.json(
      {
        error: `${member.fullName} has been part of ${sessionCount} session${
          sessionCount === 1 ? "" : "s"
        }, so removing them would delete that history too. Cancel or clear those sessions first.`,
      },
      { status: 409 }
    );
  }

  // Best-effort, and deliberately not fatal. A grant that can't be revoked
  // (already deleted by hand, Nylas having a moment) must not leave a member
  // permanently undeletable — but the caller is told, so the leftover can be
  // cleared in the Nylas dashboard rather than silently keeping calendar
  // access and counting against the plan.
  let grantsRevoked = 0;
  let grantRevokeFailed = false;
  try {
    const connections = await db
      .select()
      .from(calendarConnections)
      .where(eq(calendarConnections.memberId, memberId));

    // Stale rows point at grants on a Nylas app we no longer hold credentials
    // for — revoking those would 401 and tells us nothing. Only current-app
    // grants are ours to revoke.
    // The nulls are rows connected directly to Google/Microsoft rather than
    // through Nylas — there is no grant to revoke, and passing null here would
    // throw inside the loop and be logged as a revoke failure the admin can do
    // nothing about. Their own revocation lands with the cutover.
    const grantIds = [
      ...new Set(
        connections
          .filter((c) => c.nylasClientId === env.NYLAS_CLIENT_ID)
          .map((c) => c.nylasGrantId)
          .filter((id): id is string => id !== null)
      ),
    ];

    for (const grantId of grantIds) {
      try {
        await revokeNylasGrant(grantId);
        grantsRevoked++;
      } catch (err) {
        grantRevokeFailed = true;
        console.error("[admin/members/:id] Grant revoke failed", { memberId, grantId, err });
      }
    }

    // Calendars connected straight to Google or Microsoft, which is now all of
    // them. The comment above used to say their revocation "lands with the
    // cutover" — the cutover happened, and this was left behind, so removing
    // someone deleted our copy of their token while the app stayed authorised
    // on their Google account indefinitely. Both member-side paths
    // (/api/me/disconnect, DELETE /api/me/calendars) already hand the token
    // back; an admin removing the same person should not do less.
    //
    // Best-effort, exactly as above: a provider that won't take a token back
    // must not make someone permanently unremovable.
    for (const connection of connections) {
      if (!connection.refreshTokenEncrypted) continue;
      try {
        await revokeToken({
          provider: asCalendarProvider(connection.provider),
          refreshToken: decryptToken(connection.refreshTokenEncrypted),
        });
        grantsRevoked++;
      } catch (err) {
        grantRevokeFailed = true;
        console.error("[admin/members/:id] Token revoke failed", {
          memberId,
          connectionId: connection.id,
          err,
        });
      }
    }
  } catch (err) {
    grantRevokeFailed = true;
    console.error("[admin/members/:id] Reading connections failed", { memberId, err });
  }

  // Whatever cancelled sessions they're attached to have to go first: those
  // foreign keys carry no cascade, so the member row won't delete while they
  // point at it. Only cancelled ones can still be here — the confirmed check
  // above already refused otherwise.
  //
  // Events they ORGANISED are deleted outright, which takes their attendee
  // rows with them: an event with no organiser is not a record of anything.
  // For events somebody else led, only this person's own attendee row goes,
  // so the cancellation stays visible to everyone still involved.
  try {
    await db.batch([
      db
        .delete(events)
        .where(and(eq(events.organizerMemberId, memberId), eq(events.status, "cancelled"))),
      db.delete(eventAttendees).where(eq(eventAttendees.memberId, memberId)),
      db.delete(members).where(eq(members.id, memberId)),
    ]);
  } catch (err) {
    console.error("[admin/members/:id] Delete failed", { memberId, err });
    return NextResponse.json(
      { error: "Something went wrong removing them. Please try again." },
      { status: 500 }
    );
  }

  return NextResponse.json({
    removed: { id: member.id, fullName: member.fullName, email: member.email },
    grantsRevoked,
    grantRevokeFailed,
  });
}
