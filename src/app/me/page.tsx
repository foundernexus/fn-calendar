import { redirect } from "next/navigation";
import { requireMemberSession } from "@/lib/auth/member";
import { getMemberAvailability, getMemberConnectionState } from "@/db/queries";
import { MemberSettingsForm } from "@/components/member-settings-form";
import { OnboardingGuide } from "@/components/onboarding-guide";
import { buildMemberSteps } from "@/lib/onboarding";

// Reads a live session cookie + live connection state — must never be
// statically cached, same reasoning as /connect and /admin/find-a-time.
export const dynamic = "force-dynamic";

export default async function MePage() {
  // proxy.ts already blocks unauthenticated requests here — this is
  // defense-in-depth per the same pattern used on the admin side.
  const session = await requireMemberSession();
  if (!session) redirect("/connect");

  const [availability, connectionState] = await Promise.all([
    getMemberAvailability(session.memberId),
    getMemberConnectionState(session.memberId),
  ]);

  const steps = buildMemberSteps({
    calendars: connectionState.calendars,
    hasSavedAvailability: session.member.timezone !== null,
    isAdvisor: false,
  });

  return (
    <div className="mx-auto max-w-5xl px-6 py-10">
      <OnboardingGuide steps={steps} storageKey="member" />
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-foreground">Your availability</h1>
        {/* No longer mentions a weekly session cap — that feature was removed,
            and the sentence outlived it. */}
        <p className="mt-1.5 text-sm text-muted-foreground">
          Set the days and times you&apos;re available for sessions.
        </p>
      </div>
      <div className="mt-6">
        <MemberSettingsForm
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
        />
      </div>
    </div>
  );
}
