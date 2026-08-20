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
  taken:
    "That calendar is already connected to someone else here, so it can't be added to your profile too. Pick a different account.",
  /** Not a failed sign-in at all — an admin action rejected because the 8-hour
   * session had run out. Distinct from `expired`, which is about the sign-in
   * link itself: this person was signed in a moment ago and simply needs to do
   * it again. See lib/session-expired.ts. */
  session: "Your session expired. Please sign in again to carry on.",
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
      {/* The Beta badge moved to the header, beside the wordmark — it belongs
          on every page rather than only here, and two of them on one screen
          read as an oversight. */}
      <h1 className="text-2xl font-bold text-foreground">Sign in</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Enter your email, then pick the calendar you use. We only ever ask to
        read your calendar and add events — never your email or contacts.
      </p>
      {errorMessage && (
        <p className="mt-6 rounded-md border border-destructive/20 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {errorMessage}
        </p>
      )}
      <div className="mt-8">
        <ConnectForm initialEmail={email} />
      </div>
      {/* Google's OAuth verification reviewer checks that these are reachable
       * and, in practice, that they're linked from the page the consent screen
       * leads to — not just pasted into the Cloud Console. Both are outside
       * proxy.ts's matcher, so they load without a session. */}
      <p className="mt-10 text-xs text-muted-foreground">
        <a className="underline" href="/privacy">
          Privacy Policy
        </a>
        {" · "}
        <a className="underline" href="/terms">
          Terms of Service
        </a>
      </p>
    </div>
  );
}
