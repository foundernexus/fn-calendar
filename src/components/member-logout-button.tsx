"use client";

import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";

export function MemberLogoutButton() {
  const router = useRouter();

  async function handleLogout() {
    await fetch("/api/me/logout", { method: "POST" });
    router.push("/connect");
    router.refresh();
  }

  return (
    <Button variant="secondary" onClick={handleLogout}>
      Not you? Sign out
    </Button>
  );
}
