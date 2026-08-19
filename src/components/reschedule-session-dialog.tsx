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
import type { Slot, BookedSlot } from "@/components/results-list";
import { handleExpiredSession } from "@/lib/session-expired";

function formatWhen(unix: number, timezone: string) {
  return new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
    timeZone: timezone,
    timeZoneName: "short",
  }).format(new Date(unix * 1000));
}

/** Confirms moving an existing session to a newly-picked slot.
 *
 * No title/description/link fields, unlike CreateEventDialog: this is the same
 * session with the same people and the same details, at a different time. The
 * provider sends attendees an update rather than a cancellation plus a fresh
 * invite, so it stays one entry in their calendar. */
export function RescheduleSessionDialog({
  booked,
  slot,
  timezone,
  onOpenChange,
  onRescheduled,
}: {
  booked: BookedSlot;
  slot: Slot;
  timezone: string;
  onOpenChange: (open: boolean) => void;
  onRescheduled: () => void;
}) {
  const [submitting, setSubmitting] = useState(false);
  const durationMinutes = Math.round((slot.endUnix - slot.startUnix) / 60);

  async function handleSubmit() {
    setSubmitting(true);
    try {
      const res = await fetch(`/api/admin/events/${booked.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          startsAtUnix: slot.startUnix,
          durationMinutes,
          timezone,
        }),
      });
      const data = await res.json();
      if (handleExpiredSession(res)) return;
      if (!res.ok) {
        toast.error(data.error ?? "Something went wrong. Please try again.");
        setSubmitting(false);
        return;
      }
      toast.success("Session moved — everyone's calendar has been updated.");
      onRescheduled();
    } catch {
      toast.error("Something went wrong. Please try again.");
      setSubmitting(false);
    }
  }

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Move this session?</DialogTitle>
          <DialogDescription>{booked.title}</DialogDescription>
        </DialogHeader>

        <div className="space-y-2 rounded-lg border border-border bg-secondary/40 p-3 text-sm">
          <p className="text-muted-foreground">
            <span className="line-through">{formatWhen(booked.startUnix, timezone)}</span>
          </p>
          <p className="font-medium text-foreground">{formatWhen(slot.startUnix, timezone)}</p>
          <p className="text-xs text-muted-foreground">{durationMinutes} minutes</p>
        </div>

        {booked.attendees.length > 0 && (
          <p className="text-sm text-muted-foreground">
            {booked.attendees.length === 1
              ? "1 person will be told the session moved."
              : `${booked.attendees.length} people will be told the session moved.`}{" "}
            Their existing calendar entry is updated — they won&apos;t get a cancellation.
          </p>
        )}

        <DialogFooter>
          <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
            Keep the old time
          </Button>
          <Button type="button" onClick={handleSubmit} disabled={submitting}>
            {submitting ? "Moving…" : "Move session"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
