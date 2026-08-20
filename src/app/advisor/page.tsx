import { redirect } from "next/navigation";
import { requireMemberSession } from "@/lib/auth/member";
import {
  getMemberAvailability,
  getMemberConnectionState,
  getSessionsForMember,
} from "@/db/queries";
import { AdvisorPanel } from "@/components/advisor-panel";
import { OnboardingGuide } from "@/components/onboarding-guide";
import { buildMemberSteps } from "@/lib/onboarding";

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

  const steps = buildMemberSteps({
    calendars: connectionState.calendars,
    hasSavedAvailability: session.member.timezone !== null,
    isAdvisor: true,
  });

  return (
    <div className="mx-auto max-w-5xl py-10">
      {/* Its own storage key: an advisor gets one extra step, and dismissing
          the founder guide shouldn't hide it. */}
      <OnboardingGuide steps={steps} storageKey="advisor" />
      <AdvisorPanel
        fullName={session.member.fullName}
        timezone={session.member.timezone}
        initialAvailability={availability.map((a) => ({
          dayOfWeek: a.dayOfWeek,
          startTime: a.startTime,
          endTime: a.endTime,
        }))}
        connection={connectionState.connection}
        calendars={connectionState.calendars}
        needsReconnect={connectionState.needsReconnect}
        sessions={sessions}
      />
    </div>
  );
}
