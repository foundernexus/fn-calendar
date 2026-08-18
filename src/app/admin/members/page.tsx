import { redirect } from "next/navigation";
import { getMembersWithConnectionStatus } from "@/db/queries";
import { MemberDirectory } from "@/components/member-directory";
import { AddPersonDialog } from "@/components/add-person-dialog";
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
      {/* "People", not "Members": this list holds founders, advisors, FN staff
          and — before long — prospects, and only one of those groups is
          actually a member. The route and the `members` table keep their
          names; a display label and a data model are allowed to differ, and
          renaming the table would cost a migration for nothing. */}
      <div>
        {/* Title and primary action share a row — the standard page-header
            pattern. The description sits below both rather than pushing the
            button down, so the button lines up with the title itself and not
            with the middle of a two-line block. */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-2xl font-bold text-foreground">People</h1>
          <AddPersonDialog connectUrl={`${env.APP_URL}/connect`} />
        </div>
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
