import { redirect } from "next/navigation";
import { getMembersWithConnectionStatus } from "@/db/queries";
import { MemberDirectory } from "@/components/member-directory";
import { requireAdminSession } from "@/lib/auth/admin";
import { env } from "@/lib/env";

// Same reasoning as /admin/find-a-time: gated by proxy.ts, reads live
// connection state, and must never be prerendered against a blank DATABASE_URL.
export const dynamic = "force-dynamic";

export default async function MembersPage() {
  // Defense-in-depth — proxy.ts already blocks unauthenticated requests here.
  const session = await requireAdminSession();
  if (!session) redirect("/connect");

  const members = await getMembersWithConnectionStatus();

  return (
    <div className="py-10">
      <div>
        <h1 className="text-2xl font-bold text-foreground">Members</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Everyone who&apos;s been added, and whether their calendar is connected yet.
        </p>
      </div>
      <div className="mt-8">
        <MemberDirectory members={members} connectUrl={`${env.APP_URL}/connect`} />
      </div>
    </div>
  );
}
