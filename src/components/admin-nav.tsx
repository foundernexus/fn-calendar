"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/admin/find-a-time", label: "Schedule" },
  { href: "/admin/members", label: "People" },
  // Admins have always had a member session too — a successful connection is
  // the login, whoever you are — so /me worked for them all along. It was
  // simply never linked, which meant the people whose availability the whole
  // grid is built around had no way to reach the page where they set it. A
  // Nexus Partner's own hours matter more than anyone's: they are on calls all
  // day and are the lead on nearly every booking.
  { href: "/me", label: "My availability" },
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
