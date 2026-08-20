import Link from "next/link";
import { requireAdminSession } from "@/lib/auth/admin";
import { requireMemberSession } from "@/lib/auth/member";
import { getMemberByEmail, getMemberConnectionState } from "@/db/queries";
import { SignOutControl } from "@/components/sign-out-control";
import { AdminNav } from "@/components/admin-nav";
import { AdminConnectCalendarButton } from "@/components/admin-connect-calendar-button";

/** Server Component (not client) so it can check which session (if any) is
 * active and show the right thing — there's no separate "Connect"/"Admin"
 * nav anymore now that everyone signs in through the same form (/connect).
 * Logged out: nothing on the right. Logged in as admin: a connection-status
 * indicator for their OWN calendar (for admins who are also facilitators —
 * see AdminConnectCalendarButton) plus "Sign out". Logged in as member: just
 * "Sign out". An admin and member session can be simultaneously active
 * (see /api/admin/connect-calendar) — Sign out always clears both
 * regardless of which one this renders for. */
export async function SiteHeader() {
  const adminSession = await requireAdminSession();
  const memberSession = adminSession ? null : await requireMemberSession();

  // The admin's own connection status, fetched fresh on every request (same
  // reasoning as /me — a stale "connected" badge is worse than a tiny extra
  // query) so AdminConnectCalendarButton can actually reflect reality instead
  // of always showing the same static label.
  let adminConnection: { provider: string; grantEmail: string } | null = null;
  let adminNeedsReconnect = false;
  let adminHasMemberRow = false;
  if (adminSession) {
    const member = await getMemberByEmail(adminSession.email);
    adminHasMemberRow = !!member;
    if (member) {
      const state = await getMemberConnectionState(member.id);
      adminConnection = state.connection;
      adminNeedsReconnect = state.needsReconnect;
    }
  }

  return (
    <header className="border-b border-border bg-card">
      <div className="mx-auto flex h-16 max-w-[1200px] items-center justify-between px-6">
        {/* Beta sits beside the wordmark rather than beside "Sign in", so it is
            visible on every page instead of only at the front door. Someone who
            signed in yesterday and hits something rough today should still be
            able to see, without being told, that this is new. */}
        <div className="flex items-center gap-2">
          <Link href="/connect" className="text-lg font-bold tracking-tight text-foreground">
            FounderNexus
          </Link>
          <span className="rounded-full border border-border bg-secondary px-2 py-0.5 text-xs font-medium text-secondary-foreground">
            Beta
          </span>
        </div>
        {adminSession ? (
          // Navigation and account controls are different kinds of thing and
          // are separated by a rule rather than sitting in one undifferentiated
          // row: "where can I go" on the left of it, "who am I and what's my
          // calendar doing" on the right.
          <div className="flex items-center gap-3">
            <AdminNav />
            <span className="h-5 w-px bg-border" aria-hidden />
            <div className="flex items-center gap-2">
              {adminHasMemberRow && (
                <AdminConnectCalendarButton
                  connection={adminConnection}
                  needsReconnect={adminNeedsReconnect}
                />
              )}
              <SignOutControl />
            </div>
          </div>
        ) : memberSession ? (
          <SignOutControl />
        ) : null}
      </div>
    </header>
  );
}
