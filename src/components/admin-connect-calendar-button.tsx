"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

type Connection = { provider: string; grantEmail: string } | null;

/** The shared /connect form always routes an admin email to the admin
 * dashboard, so an admin who's also a member (a facilitator) has no way to
 * reach the calendar-connect flow through it — this is that way back in,
 * for their own registered email. See /api/admin/connect-calendar.
 *
 * `connection` is fetched fresh server-side by site-header.tsx on every
 * request, so this reflects real status instead of a static label — the
 * same class of bug (a button that always said "Connect your calendar"
 * whether or not you already were) that the founder-facing /me page never
 * had, since it's always shown live status from day one. */
export function AdminConnectCalendarButton({ connection }: { connection: Connection }) {
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

  if (connection) {
    return (
      <div className="flex items-center gap-2">
        <Badge className="bg-accent text-accent-foreground" title={connection.grantEmail}>
          Calendar connected
        </Badge>
        <Button variant="ghost" size="sm" onClick={handleClick} disabled={submitting}>
          {submitting ? "Reconnecting…" : "Reconnect"}
        </Button>
      </div>
    );
  }

  return (
    <Button variant="secondary" size="sm" onClick={handleClick} disabled={submitting}>
      {submitting ? "Connecting…" : "Connect your calendar"}
    </Button>
  );
}
