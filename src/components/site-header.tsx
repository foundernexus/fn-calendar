import Link from "next/link";
import { requireAdminSession } from "@/lib/auth/admin";
import { SiteHeaderNav } from "@/components/site-header-nav";

/** Server Component (not client) specifically so it can check the admin
 * session cookie server-side and decide whether "Admin" belongs in the nav
 * at all — this is a UI nicety, not a security boundary: /admin and
 * /api/admin/* are already independently gated by proxy.ts + every route's
 * own requireAdminSession() call, regardless of whether this link is shown. */
export async function SiteHeader() {
  const session = await requireAdminSession();

  const navItems = [
    { href: "/connect", label: "Connect" },
    ...(session ? [{ href: "/admin", label: "Admin" }] : []),
  ];

  return (
    <header className="border-b border-border bg-card">
      <div className="mx-auto flex h-16 max-w-[1200px] items-center justify-between px-6">
        <Link
          href="/connect"
          className="text-lg font-bold tracking-tight text-foreground"
        >
          FounderNexus
        </Link>
        <SiteHeaderNav items={navItems} />
      </div>
    </header>
  );
}
