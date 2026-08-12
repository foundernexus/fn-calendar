import { redirect } from "next/navigation";
import { getMemberByEmail, getActiveConnections } from "@/db/queries";
import { ConnectForm } from "@/components/connect-form";
import { requireMemberSession } from "@/lib/auth/member";
import { requireAdminSession } from "@/lib/auth/admin";

// Reads live connection state and must never be statically cached — currently
// only dynamic as a side effect of reading searchParams before the DB call;
// making it explicit means it stays correct even if that ordering changes.
export const dynamic = "force-dynamic";

export default async function ConnectPage({ searchParams }: PageProps<"/connect">) {
  const params = await searchParams;
  const email = typeof params.email === "string" ? params.email : undefined;
  const hadError = params.status === "error";

  // A returning, already-logged-in person (admin or member) shouldn't have
  // to re-enter their email — send them straight to their real destination.
  // But NOT if they just landed here after a failed OAuth attempt (e.g.
  // Reconnect from /me with an expired link) — they still have their old
  // session, and silently bouncing them back with no feedback would hide
  // the failure and strand them in a retry loop.
  if (!hadError) {
    const adminSession = await requireAdminSession();
    if (adminSession) redirect("/admin/find-a-time");
    const memberSession = await requireMemberSession();
    if (memberSession) redirect("/me");
  }

  let initialStatus: "connected" | "not_connected" = "not_connected";
  let initialProvider: string | undefined;
  let initialGrantEmail: string | undefined;

  if (email) {
    const member = await getMemberByEmail(email);
    if (member) {
      const active = await getActiveConnections([member.id]);
      if (active.length > 0) {
        initialStatus = "connected";
        initialProvider = active[0].provider;
        // The actually-connected calendar account can differ from the
        // registered email (e.g. a personal Gmail) — show it explicitly so a
        // member can tell if they connected the wrong account.
        initialGrantEmail = active[0].grant_email;
      }
    }
  }

  return (
    <div className="mx-auto max-w-md py-16">
      <h1 className="text-2xl font-bold text-foreground">Sign in</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Enter your email to get started. If you haven&apos;t connected your calendar
        yet (Google, Microsoft, or iCloud), you&apos;ll do that next.
      </p>
      {hadError && (
        <p className="mt-6 rounded-md border border-destructive/20 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          That connection attempt didn&apos;t go through — the link may have expired.
          Please try again.
        </p>
      )}
      <div className="mt-8">
        <ConnectForm
          initialEmail={email}
          initialStatus={initialStatus}
          initialProvider={initialProvider}
          initialGrantEmail={initialGrantEmail}
        />
      </div>
    </div>
  );
}
