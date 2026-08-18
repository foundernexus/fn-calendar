"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/admin/find-a-time", label: "Find a time" },
  { href: "/admin/members", label: "People" },
];

/** Client-side purely so it can read the current path — the header itself
 * stays a Server Component (it needs session and connection state).
 *
 * `startsWith` rather than an exact match so a future nested page (a single
 * person's detail view under /admin/members/…) still marks its section as
 * active instead of leaving the whole nav looking unvisited. */
export function AdminNav() {
  const pathname = usePathname();

  return (
    <nav className="flex items-center gap-1 text-sm">
      {LINKS.map((link) => {
        const active = pathname.startsWith(link.href);
        return (
          <Link
            key={link.href}
            href={link.href}
            aria-current={active ? "page" : undefined}
            className={
              active
                ? "rounded-md bg-secondary px-2 py-1 font-medium text-secondary-foreground"
                : "rounded-md px-2 py-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            }
          >
            {link.label}
          </Link>
        );
      })}
    </nav>
  );
}
