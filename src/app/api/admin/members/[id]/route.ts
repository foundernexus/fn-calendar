import { NextResponse } from "next/server";
import { eq, or, sql as raw } from "drizzle-orm";
import { db } from "@/db";
import { members, events, eventAttendees, calendarConnections } from "@/db/schema";
import { requireAdminSession, isAdminEmail } from "@/lib/auth/admin";
import { revokeNylasGrant } from "@/lib/nylas";
import { env } from "@/lib/env";

/** Removes a member for good: revokes their calendar grant at Nylas, then
 * deletes the row (their connections and stated availability cascade with it).
 *
 * Deliberately refuses when the member has any session history. `events` and
 * `event_attendees` reference members WITHOUT `onDelete: cascade`, so the
 * delete would fail at the database anyway — but the reason matters more than
 * the constraint: those rows are the record of real meetings that really
 * happened, and quietly destroying them to tidy up a roster is not a trade an
 * admin should be able to make by clicking "Remove". Someone who has been in
 * sessions needs archiving, which is a different feature.
 *
 * That leaves this squarely aimed at what it's for: people added by mistake,
 * duplicates, wrong addresses, and anyone who never connected at all. */
export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireAdminSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
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

  let sessionCount = 0;
  try {
    const [{ count }] = await db
      .select({ count: raw<number>`count(*)::int` })
      .from(events)
      .leftJoin(eventAttendees, eq(eventAttendees.eventId, events.id))
      .where(or(eq(events.organizerMemberId, memberId), eq(eventAttendees.memberId, memberId)));
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
    const grantIds = [
      ...new Set(
        connections
          .filter((c) => c.nylasClientId === env.NYLAS_CLIENT_ID)
          .map((c) => c.nylasGrantId)
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
  } catch (err) {
    grantRevokeFailed = true;
    console.error("[admin/members/:id] Reading connections failed", { memberId, err });
  }

  try {
    await db.delete(members).where(eq(members.id, memberId));
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
