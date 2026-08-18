"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";

type Connection = { provider: string; grantEmail: string } | null;

/** The shared /connect form always routes an admin email to the admin
 * dashboard, so an admin who's also a member (a facilitator) has no way to
 * reach the calendar-connect flow through it — this is that way back in,
 * for their own registered email. See /api/admin/connect-calendar.
 *
 * Both props are fetched fresh server-side by site-header.tsx on every
 * request, so this reflects real status instead of a static label — the
 * same class of bug (a button that always said "Connect your calendar"
 * whether or not you already were) that the founder-facing /me page never
 * had, since it's shown live status from day one.
 *
 * Deliberately near-silent in the healthy case. This used to render a
 * "Calendar connected" badge AND a Reconnect button permanently, which is a
 * lot of chrome next to the nav for a state that is almost always true — and
 * a standing invitation to click Reconnect by accident. A status that never
 * changes is background noise; the space is worth spending only when
 * something needs doing. */
export function AdminConnectCalendarButton({
  connection,
  needsReconnect,
}: {
  connection: Connection;
  needsReconnect: boolean;
}) {
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
    // A dot, not a tick: a tick reads as "task completed", where this is a
    // standing state. Clicking it still reaches the reconnect flow, so the
    // way out of a stale grant doesn't disappear — it just stops shouting.
    return (
      <button
        type="button"
        onClick={handleClick}
        disabled={submitting}
        title={`Connected as ${connection.grantEmail} — click to reconnect`}
        className="flex items-center gap-1.5 rounded-md px-2 py-1 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-60"
      >
        <span className="inline-block size-2 shrink-0 rounded-full bg-green-500" aria-hidden />
        {submitting ? "Reconnecting…" : "Calendar"}
        <span className="sr-only">
          Connected as {connection.grantEmail}. Activate to reconnect.
        </span>
      </button>
    );
  }

  // Both remaining states are actionable, so both get a real button — but
  // they're different problems and shouldn't look identical. A stale grant
  // silently breaks availability lookups for everyone in a search (see
  // isConnectionUsable), so it earns the destructive treatment.
  return (
    <Button
      variant={needsReconnect ? "destructive" : "secondary"}
      size="sm"
      onClick={handleClick}
      disabled={submitting}
    >
      {submitting
        ? "Connecting…"
        : needsReconnect
          ? "Reconnect your calendar"
          : "Connect your calendar"}
    </Button>
  );
}
