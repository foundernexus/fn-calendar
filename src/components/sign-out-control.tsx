"use client";

import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";

/** One "Sign out" control for the top-right of the nav. Always clears both
 * session cookies via /api/logout (not just the "active" one) — an admin
 * who's also a member can legitimately hold both at once, and a
 * kind-specific logout would silently leave the other alive. */
export function SignOutControl() {
  const router = useRouter();

  async function handleSignOut() {
    await fetch("/api/logout", { method: "POST" });
    router.push("/connect");
    router.refresh();
  }

  return (
    <Button variant="secondary" size="sm" onClick={handleSignOut}>
      Sign out
    </Button>
  );
}
