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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { Slot } from "@/components/results-list";

export function CreateEventDialog({
  slot,
  organizerMemberId,
  organizerName,
  guestMemberIds,
  guestNames,
  timezone,
  onOpenChange,
  onCreated,
}: {
  slot: Slot;
  organizerMemberId: number;
  organizerName: string;
  guestMemberIds: number[];
  guestNames: string[];
  timezone: string;
  onOpenChange: (open: boolean) => void;
  onCreated: () => void;
}) {
  // Derived from the slot itself (not a separately-tracked value) so it can
  // never drift from what was actually searched for this slot.
  const durationMinutes = Math.round((slot.endUnix - slot.startUnix) / 60);

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [meetingUrl, setMeetingUrl] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    try {
      const res = await fetch("/api/admin/events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          guestMemberIds,
          organizerMemberId,
          title,
          description: description || undefined,
          meetingUrl: meetingUrl || undefined,
          startsAtUnix: slot.startUnix,
          durationMinutes,
          timezone,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? "Something went wrong. Please try again.");
        setSubmitting(false);
        return;
      }
      toast.success(
        data.alreadyExisted ? "That event already existed — no duplicate created." : "Event created — invites are going out."
      );
      onCreated();
    } catch {
      toast.error("Something went wrong. Please try again.");
      setSubmitting(false);
    }
  }

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Create event</DialogTitle>
          <DialogDescription>{slot.label}</DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="event-title">Title</Label>
            <Input
              id="event-title"
              required
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Expert session: pricing strategy"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="event-description">Description</Label>
            <Textarea
              id="event-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Optional"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="event-meeting-url">Meeting URL</Label>
            <Input
              id="event-meeting-url"
              type="url"
              value={meetingUrl}
              onChange={(e) => setMeetingUrl(e.target.value)}
              placeholder="https://zoom.us/j/… (optional)"
            />
          </div>
          <div className="grid grid-cols-2 gap-4 rounded-lg border border-border bg-secondary/40 p-3 text-sm">
            <div>
              <p className="text-xs text-muted-foreground">Session lead</p>
              <p className="text-foreground">{organizerName}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">
                Guest{guestNames.length === 1 ? "" : "s"}
              </p>
              <p className="text-foreground">{guestNames.join(", ")}</p>
            </div>
          </div>
          <DialogFooter>
            <Button type="submit" disabled={submitting}>
              {submitting ? "Creating…" : "Create event"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
