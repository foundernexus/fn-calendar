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
        <h1 className="text-2xl font-bold text-foreground">Find a time</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Pick the session lead and guests, and see when everyone&apos;s free.
        </p>
      </div>
      <div className="mt-8">
        <FindATimeForm members={members} />
      </div>
    </div>
  );
}
