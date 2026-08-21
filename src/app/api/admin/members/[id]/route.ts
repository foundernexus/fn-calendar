import { NextResponse } from "next/server";
import { eq, or, and, sql as raw } from "drizzle-orm";
import { db } from "@/db";
import { members, events, eventAttendees, calendarConnections } from "@/db/schema";
import { requireAdminSession, isAdminEmail } from "@/lib/auth/admin";
import { revokeNylasGrant } from "@/lib/nylas";
import { revokeToken, asCalendarProvider } from "@/lib/calendar";
import { decryptToken } from "@/lib/calendar/crypto";
import { env } from "@/lib/env";

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
