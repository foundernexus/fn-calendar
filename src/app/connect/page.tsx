import { redirect } from "next/navigation";
import { ConnectForm } from "@/components/connect-form";
import { requireMemberSession } from "@/lib/auth/member";
import { requireAdminSession } from "@/lib/auth/admin";

// Reads live session cookies and must never be statically cached.
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
        <ConnectForm initialEmail={email} />
      </div>
    </div>
  );
}
