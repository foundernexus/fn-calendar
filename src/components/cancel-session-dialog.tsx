"use client";

import { useState } from "react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import type { BookedSlot } from "@/components/results-list";

/** Confirmation before cancelling a booked session.
 *
 * Deliberately a two-step with an explicit warning rather than a one-click
 * action on the grid. Cancelling withdraws the event from every attendee's
 * calendar and sends the provider's own cancellation email immediately —
 * there's no undo, and no quiet mode. Recreating it would be a new session
 * with new invites, so a misclick is visible to everyone who was booked. */
export function CancelSessionDialog({
  booked,
  timezone,
  onOpenChange,
  onCancelled,
  onReschedule,
}: {
  booked: BookedSlot;
  timezone: string;
  onOpenChange: (open: boolean) => void;
  onCancelled: () => void;
  /** Switches the search above into "find a new time for this session" mode.
   * Offered alongside cancelling because moving a session is the far more
   * common intent, and doing it as cancel-then-rebook sends everyone a
   * cancellation before the replacement invite lands. */
  onReschedule: () => void;
}) {
  const [submitting, setSubmitting] = useState(false);

  const when = new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
    timeZone: timezone,
    timeZoneName: "short",
  }).format(new Date(booked.startUnix * 1000));

  async function handleCancel() {
    setSubmitting(true);
    try {
      const res = await fetch(`/api/admin/events/${booked.id}`, { method: "DELETE" });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? "Something went wrong. Please try again.");
        setSubmitting(false);
        return;
      }
      toast.success(
        data.alreadyCancelled
          ? "That session was already cancelled."
          : // Says the slot may lag on purpose: it's removed from our grid at
            // once, but going free again depends on the calendar provider
            // catching up, which takes a moment. Without this the cell looks
            // stuck and the obvious guess is that cancelling half-failed.
            "Session cancelled. The slot can take a minute to show as free again."
      );
      onCancelled();
    } catch {
      toast.error("Something went wrong. Please try again.");
      setSubmitting(false);
    }
  }

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{booked.title}</DialogTitle>
          <DialogDescription>{when}</DialogDescription>
        </DialogHeader>

        {/* Moving comes first and cancelling is the destructive fallback —
            the older version offered only cancelling, which pushed people
            into cancel-then-rebook for what was really a reschedule. */}
        <Button type="button" variant="secondary" onClick={onReschedule}>
          Find a new time for this session
        </Button>

        {/* Who this actually hits. Cancelling used to name only the session,
            so an admin confirming it had no idea from this screen how many
            people were about to get a cancellation email, or who. */}
        {booked.attendees.length > 0 && (
          <div className="rounded-lg border border-border bg-secondary/40 p-3">
            <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
              {booked.attendees.length} invited
            </p>
            <ul className="mt-2 space-y-1">
              {booked.attendees.map((a) => (
                <li key={a.email} className="text-sm text-foreground">
                  {a.fullName}
                  {a.role === "advisor" && (
                    <span className="ml-2 text-xs text-muted-foreground">(advisor)</span>
                  )}
                  <span className="block text-xs text-muted-foreground">{a.email}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="rounded-lg border border-destructive/20 bg-destructive/10 p-3 text-sm text-destructive">
          This removes the session from everyone&apos;s calendar and sends them a cancellation
          email straight away. It can&apos;t be undone — rebooking would create a new session and
          new invites.
        </div>

        <DialogFooter>
          <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
            Keep it
          </Button>
          <Button
            type="button"
            variant="destructive"
            onClick={handleCancel}
            disabled={submitting}
          >
            {submitting ? "Cancelling…" : "Cancel session"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
