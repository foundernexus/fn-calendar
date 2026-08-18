import { redirect } from "next/navigation";
import { getMembersWithConnectionStatus } from "@/db/queries";
import { FindATimeForm } from "@/components/find-a-time-form";
import { requireAdminSession } from "@/lib/auth/admin";

// Authenticated (gated by proxy.ts) and reads live connection state — must
// never be statically cached. Without this, Next tries to prerender it at
// build time and crashes on the still-blank DATABASE_URL.
export const dynamic = "force-dynamic";

export default async function FindATimePage() {
  // proxy.ts already blocks unauthenticated requests here — this is
  // defense-in-depth per Next's own guidance not to rely on Proxy alone.
  const session = await requireAdminSession();
  if (!session) redirect("/connect");

  const members = await getMembersWithConnectionStatus();

  return (
    <div className="py-10">
      <div>
        {/* Label only — the route stays /admin/find-a-time. "Schedule" also
            covers the second half of what this page does (booking the thing),
            where "Find a time" only named the search. */}
        <h1 className="text-2xl font-bold text-foreground">Schedule</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Pick who&apos;s in the session, see when everyone&apos;s free, and book it.
        </p>
      </div>
      <div className="mt-8">
        <FindATimeForm members={members} />
      </div>
    </div>
  );
}
