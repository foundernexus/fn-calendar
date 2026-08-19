"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ProviderIcon } from "@/components/provider-icon";
import type { MemberCalendar } from "@/db/queries";

/** Every calendar a member has connected.
 *
 * The rule the whole page rests on, and the reason this says it out loud:
 * ALL of these are checked for conflicts, exactly ONE receives the session.
 * Someone with a personal and a work calendar is only offered a slot when both
 * are free, but the invite lands in one place — writing to all of them would
 * put the same session in their diary several times as entries that cancel
 * independently of each other. */
export function CalendarList({ calendars }: { calendars: MemberCalendar[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);

  /** Adds a calendar, or repairs the one named by `connectionId`. */
  async function connect(provider: "google" | "microsoft", connectionId?: number) {
    setBusy(connectionId ? `fix:${connectionId}` : `connect:${provider}`);
    try {
      const res = await fetch("/api/me/calendars", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, connectionId }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? "Something went wrong. Please try again.");
        setBusy(null);
        return;
      }
      window.location.href = data.url;
    } catch {
      toast.error("Something went wrong. Please try again.");
      setBusy(null);
    }
  }

  async function setInviteTarget(connectionId: number) {
    setBusy(`target:${connectionId}`);
    try {
      const res = await fetch("/api/me/calendars", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ connectionId }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? "Something went wrong. Please try again.");
        return;
      }
      toast.success("Sessions will be added to that calendar.");
      router.refresh();
    } catch {
      toast.error("Something went wrong. Please try again.");
    } finally {
      setBusy(null);
    }
  }

  async function removeCalendar(calendar: MemberCalendar) {
    setBusy(`remove:${calendar.id}`);
    try {
      const res = await fetch("/api/me/calendars", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ connectionId: calendar.id }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? "Something went wrong. Please try again.");
        return;
      }
      toast[data.grantRevokeFailed ? "warning" : "success"](
        data.grantRevokeFailed
          ? "Removed here, but the calendar couldn't be revoked with the provider."
          : `${calendar.grantEmail} removed.`
      );
      router.refresh();
    } catch {
      toast.error("Something went wrong. Please try again.");
    } finally {
      setBusy(null);
    }
  }

  return (
    // data-tour is what the walkthrough points at — see GuidedTour. Kept as a
    // data attribute rather than an id so it reads as "something looks for
    // this" and doesn't get repurposed as a styling or anchor hook.
    <div data-tour="calendars" className="rounded-lg border border-border bg-card p-6 shadow-card">
      <p className="text-base font-semibold text-foreground">Your calendars</p>
      <p className="mt-1 text-sm text-muted-foreground">
        {calendars.length > 1
          ? "All of these are checked before you're offered a time. Sessions are added to the one marked below."
          : "Checked before you're offered a time, and where your sessions are added. Add another if you keep work and personal separate."}
      </p>

      {calendars.length > 0 && (
        <ul className="mt-4 divide-y divide-border">
          {calendars.map((c) => (
            <li key={c.id} className="flex flex-wrap items-center gap-3 py-3">
              <ProviderIcon provider={c.provider} />
              <span className="min-w-0 flex-1 truncate text-sm text-foreground">
                {c.grantEmail}
                {c.needsReconnect && (
                  <span className="block text-xs text-destructive">
                    Not being checked — sign in again to fix it
                  </span>
                )}
              </span>

              {c.needsReconnect ? (
                // A broken calendar gets its own repair, hinted at its own
                // address. The page-level Reconnect only appeared once NOTHING
                // worked, so somebody with one good and one broken calendar had
                // no way to fix the broken one — and no sign it had stopped
                // being checked at all.
                <Button
                  type="button"
                  variant="destructive"
                  size="sm"
                  onClick={() => connect(c.provider === "microsoft" ? "microsoft" : "google", c.id)}
                  disabled={busy !== null}
                >
                  {busy === `fix:${c.id}` ? "Opening…" : "Reconnect"}
                </Button>
              ) : (
                /* A radio, not a toggle: exactly one calendar receives sessions,
                   and a set of toggles would suggest several could. */
                <label className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
                  <input
                    type="radio"
                    name="invite-target"
                    checked={c.isInviteTarget}
                    onChange={() => setInviteTarget(c.id)}
                    disabled={busy !== null}
                    className="size-3.5 accent-primary"
                  />
                  Add sessions here
                </label>
              )}

              {calendars.length > 1 && (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  title={`Remove ${c.grantEmail}`}
                  onClick={() => removeCalendar(c)}
                  disabled={busy !== null}
                >
                  <Trash2 className="text-muted-foreground" />
                  <span className="sr-only">Remove {c.grantEmail}</span>
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}

      <div className="mt-4 flex flex-wrap gap-2">
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={() => connect("google")}
          disabled={busy !== null}
        >
          {calendars.length === 0 ? "Connect Google" : "Connect another Google calendar"}
        </Button>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={() => connect("microsoft")}
          disabled={busy !== null}
        >
          {calendars.length === 0 ? "Connect Microsoft" : "Connect another Microsoft calendar"}
        </Button>
      </div>
    </div>
  );
}
