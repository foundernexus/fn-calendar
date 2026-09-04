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

  // Whose calendar this move goes onto, if anyone's. Only ever the lead's own —
  // the grid does not open this dialog for a slot anybody else is busy in.
  const busyMemberIds = slot.busyMemberIds ?? [];
  const overBusy = busyMemberIds.length > 0;

  // This date alone unless asked otherwise — the same default as cancelling,
  // and for the same reason: moving a whole rhythm because somebody meant to
  // shift one afternoon is the expensive way round to get this wrong.
  const isSeries = Boolean(booked.recurrenceRule);
  const [scope, setScope] = useState<"occurrence" | "series">("occurrence");
  const wholeSeries = !isSeries || scope === "series";

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
          // Absent unless somebody is knowingly being moved onto — see the same
          // field on CreateEventDialog.
          ...(overBusy ? { overrideBusyMemberIds: busyMemberIds } : {}),
          ...(wholeSeries || booked.occurrenceStartUnix === undefined
            ? {}
            : { occurrenceStartUnix: booked.occurrenceStartUnix }),
        }),
      });
      const data = await res.json();
      if (handleExpiredSession(res)) return;
      if (!res.ok) {
        toast.error(data.error ?? "Something went wrong. Please try again.");
        setSubmitting(false);
        return;
      }
      toast.success(
        wholeSeries
          ? "Session moved — everyone's calendar has been updated."
          : "That date moved. The rest of the series is unchanged."
      );
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

        {isSeries && (
          <div className="space-y-2 rounded-md border border-border p-3 text-sm">
            <p className="text-muted-foreground">This session repeats. Move:</p>
            <label className="flex items-start gap-2 text-foreground">
              <input
                type="radio"
                name="move-scope"
                className="mt-1"
                checked={scope === "occurrence"}
                onChange={() => setScope("occurrence")}
              />
              <span>
                <span className="font-medium">This date only</span>
                <span className="block text-xs text-muted-foreground">
                  Every other date keeps its usual time.
                </span>
              </span>
            </label>
            <label className="flex items-start gap-2 text-foreground">
              <input
                type="radio"
                name="move-scope"
                className="mt-1"
                checked={scope === "series"}
                onChange={() => setScope("series")}
              />
              <span>
                <span className="font-medium">Every date</span>
                <span className="block text-xs text-muted-foreground">
                  The whole rhythm shifts to this weekday and time.
                </span>
              </span>
            </label>
          </div>
        )}

        {booked.attendees.length > 0 && (
          <p className="text-sm text-muted-foreground">
            {booked.attendees.length === 1
              ? "1 person will be told the session moved."
              : `${booked.attendees.length} people will be told the session moved.`}{" "}
            Their existing calendar entry is updated — they won&apos;t get a cancellation.
          </p>
        )}

        {/* A repeating session can't be moved onto busy time at all — the server
            refuses it, so say so here rather than letting someone fill the
            dialog in and be turned away by a toast. See the booking route for
            why a series is different. */}
        {overBusy && (
          <div className={`rounded-lg border p-3 text-sm ${isSeries ? "border-destructive/20 bg-destructive/10 text-destructive" : "border-border bg-secondary/40 text-muted-foreground"}`}>
            {isSeries ? (
              <>
                You&apos;re busy at this time, and a repeating session can&apos;t be moved onto
                it. Pick a time that&apos;s clear, or cancel this date and book a one-off
                alongside your hold.
              </>
            ) : (
              <>
                You&apos;re already busy at this time. The session is moved alongside what&apos;s
                already in your calendar — that entry isn&apos;t touched. Everyone else on the
                session is free then.
              </>
            )}
          </div>
        )}

        <DialogFooter>
          <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
            Keep the old time
          </Button>
          <Button
            type="button"
            onClick={handleSubmit}
            // The server refuses this combination outright, so the button that
            // would send it doesn't exist.
            disabled={submitting || (overBusy && isSeries)}
          >
            {submitting
              ? "Moving…"
              : overBusy
                ? "Move over it anyway"
                : wholeSeries
                  ? "Move session"
                  : "Move this date"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
