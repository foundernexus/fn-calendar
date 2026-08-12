"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";

/** The shared /connect form always routes an admin email to the admin
 * dashboard, so an admin who's also a member (a facilitator) has no way to
 * reach the calendar-connect flow through it — this is that way back in,
 * for their own registered email. See /api/admin/connect-calendar. */
export function AdminConnectCalendarButton() {
  const [submitting, setSubmitting] = useState(false);

  async function handleClick() {
    setSubmitting(true);
    try {
      const res = await fetch("/api/admin/connect-calendar", { method: "POST" });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? "Something went wrong. Please try again.");
        setSubmitting(false);
        return;
      }
      window.location.href = data.url;
    } catch {
      toast.error("Something went wrong. Please try again.");
      setSubmitting(false);
    }
  }

  return (
    <Button variant="secondary" size="sm" onClick={handleClick} disabled={submitting}>
      Connect your calendar
    </Button>
  );
}
