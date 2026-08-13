import { redirect } from "next/navigation";
import { requireMemberSession } from "@/lib/auth/member";
import { getMemberAvailability, getMemberConnectionState } from "@/db/queries";
import { MemberSettingsForm } from "@/components/member-settings-form";

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

  return (
    <div className="mx-auto max-w-3xl py-8">
      <div>
        <h1 className="text-xl font-bold text-foreground">Your availability</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Set the days and times you&apos;re available for sessions, and how many
          you&apos;ll take per week.
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
    </div>
  );
}
