import { redirect } from "next/navigation";
import { requireMemberSession } from "@/lib/auth/member";
import { getMemberAvailability, getActiveConnections } from "@/db/queries";
import { MemberSettingsForm } from "@/components/member-settings-form";

// Reads a live session cookie + live connection state — must never be
// statically cached, same reasoning as /connect and /admin/find-a-time.
export const dynamic = "force-dynamic";

export default async function MePage() {
  // proxy.ts already blocks unauthenticated requests here — this is
  // defense-in-depth per the same pattern used on the admin side.
  const session = await requireMemberSession();
  if (!session) redirect("/connect");

  const [availability, activeConnections] = await Promise.all([
    getMemberAvailability(session.memberId),
    getActiveConnections([session.memberId]),
  ]);
  const connection = activeConnections[0] ?? null;

  return (
    <div className="mx-auto max-w-2xl py-16">
      <div>
        <h1 className="text-2xl font-bold text-foreground">Your availability</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Set the days and times you&apos;re available for sessions, and how many
          you&apos;ll take per week.
        </p>
      </div>
      <div className="mt-8">
        <MemberSettingsForm
          fullName={session.member.fullName}
          timezone={session.member.timezone}
          weeklySessionCap={session.member.weeklySessionCap}
          initialAvailability={availability.map((a) => ({
            dayOfWeek: a.dayOfWeek,
            startTime: a.startTime,
            endTime: a.endTime,
          }))}
          connection={
            connection
              ? { provider: connection.provider, grantEmail: connection.grant_email }
              : null
          }
        />
      </div>
    </div>
  );
}
