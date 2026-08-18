import { redirect } from "next/navigation";
import { requireMemberSession } from "@/lib/auth/member";
import {
  getMemberAvailability,
  getMemberConnectionState,
  getSessionsForMember,
} from "@/db/queries";
import { MemberSettingsForm } from "@/components/member-settings-form";
import { AdvisorSessionList } from "@/components/advisor-session-list";

// Reads a live session cookie + live connection state — must never be
// statically cached, same reasoning as /me and /admin/find-a-time.
export const dynamic = "force-dynamic";

/** The advisor panel. Same login as everyone else — /api/nylas/callback routes
 * members here instead of /me when `isAdvisor` is set. proxy.ts already
 * guarantees a valid member session; the advisor check has to happen here
 * because it needs a DB read that the cookie-only middleware avoids on
 * purpose.
 *
 * Availability and capacity reuse MemberSettingsForm verbatim rather than
 * getting an advisor-specific copy — an advisor's weekly hours and session cap
 * mean exactly what a member's do, and two forms would drift. */
export default async function AdvisorPage() {
  const session = await requireMemberSession();
  if (!session) redirect("/connect");

  // Not an advisor: send them to the panel that IS theirs rather than showing
  // an error. Someone whose advisor flag was removed still has a valid session
  // and a bookmark to this page.
  if (!session.member.isAdvisor) redirect("/me");

  const [availability, connectionState, sessions] = await Promise.all([
    getMemberAvailability(session.memberId),
    getMemberConnectionState(session.memberId),
    getSessionsForMember(session.memberId),
  ]);

  return (
    <div className="mx-auto max-w-3xl py-8">
      <div>
        <h1 className="text-xl font-bold text-foreground">Advisor settings</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Set when you&apos;re available for sessions and how many you&apos;ll take per week.
          Founders are only ever offered times that work for you.
        </p>
      </div>

      <div className="mt-5">
        <MemberSettingsForm
          fullName={session.member.fullName}
          timezone={session.member.timezone}
          weeklySessionCap={session.member.weeklySessionCap}
          initialAvailability={availability.map((a) => ({
            dayOfWeek: a.dayOfWeek,
            startTime: a.startTime,
            endTime: a.endTime,
          }))}
          connection={connectionState.connection}
          needsReconnect={connectionState.needsReconnect}
        />
      </div>

      <div className="mt-8">
        <h2 className="text-lg font-semibold text-foreground">Your sessions</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Sessions you&apos;ve been booked into.
        </p>
        <div className="mt-3">
          <AdvisorSessionList sessions={sessions} />
        </div>
      </div>
    </div>
  );
}
