import { redirect } from "next/navigation";
import { ConnectForm } from "@/components/connect-form";
import { requireMemberSession } from "@/lib/auth/member";
import { requireAdminSession } from "@/lib/auth/admin";

// Reads live session cookies and must never be statically cached.
export const dynamic = "force-dynamic";

/** Keyed to the FAILURE_STATUS values set by /api/nylas/callback. "error" is
 * kept as a generic fallback so older in-flight links (and any future caller)
 * still render feedback rather than silently bouncing. */
const FAILURE_MESSAGES: Record<string, string> = {
  expired: "That sign-in link expired before you finished. Please try again.",
  provider:
    "We couldn't reach your calendar provider. That's a configuration problem on our side, not something you did — please let an admin know.",
  denied:
    "The calendar account you signed in with doesn't match the email you entered. Use the exact address you were registered under.",
  error: "That connection attempt didn't go through. Please try again.",
};

export default async function ConnectPage({ searchParams }: PageProps<"/connect">) {
  const params = await searchParams;
  const email = typeof params.email === "string" ? params.email : undefined;
  const status = typeof params.status === "string" ? params.status : undefined;
  const errorMessage = status ? FAILURE_MESSAGES[status] : undefined;
  const hadError = !!errorMessage;

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
        yet (Google or Microsoft), you&apos;ll do that next. We only ever ask for
        calendar access — never your email or contacts.
      </p>
      {errorMessage && (
        <p className="mt-6 rounded-md border border-destructive/20 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {errorMessage}
        </p>
      )}
      <div className="mt-8">
        <ConnectForm initialEmail={email} />
      </div>
    </div>
  );
}
