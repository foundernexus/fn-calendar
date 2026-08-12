"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

// "Admin" is always shown, even to logged-out visitors — clicking it just
// lands on the login gate (/admin redirects to /admin/login when
// unauthenticated), which is the actual security boundary. Hiding the link
// itself isn't a real protection (anyone who knows /admin exists can type
// it directly) and it broke admins' ability to discover the login page
// before they'd logged in — so this stays simple and static rather than a
// Server Component checking the session cookie.
const navItems = [
  { href: "/connect", label: "Connect" },
  { href: "/admin", label: "Admin" },
];

export function SiteHeader() {
  const pathname = usePathname();

  return (
    <header className="border-b border-border bg-card">
      <div className="mx-auto flex h-16 max-w-[1200px] items-center justify-between px-6">
        <Link
          href="/connect"
          className="text-lg font-bold tracking-tight text-foreground"
        >
          FounderNexus
        </Link>
        <nav aria-label="Main" className="flex items-center gap-6">
          {navItems.map((item) => {
            const isActive = pathname.startsWith(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={isActive ? "page" : undefined}
                className={cn(
                  "text-sm font-medium transition-colors hover:text-foreground",
                  isActive ? "text-foreground" : "text-muted-foreground"
                )}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>
      </div>
    </header>
  );
}
