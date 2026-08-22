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
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { Slot } from "@/components/results-list";
import { handleExpiredSession } from "@/lib/session-expired";

/** How many sessions a series can hold. Twelve four-weekly is roughly a year,
 * which is as far ahead as booking someone's calendar is a kindness. */
const REPEAT_COUNTS = [3, 6, 12] as const;

export function CreateEventDialog({
  slot,
  organizerMemberId,
  organizerName,
  advisorMemberId,
  advisorName,
  guestMemberIds,
  guestNames,
  timezone,
  defaultMeetingUrl = "",
  onOpenChange,
  onCreated,
}: {
  slot: Slot;
  organizerMemberId: number;
  organizerName: string;
  /** Null for sessions without an advisor, which is the common case. */
  advisorMemberId: number | null;
  advisorName: string | null;
  guestMemberIds: number[];
  guestNames: string[];
  timezone: string;
  /** The session lead's standing link for this length, if they hold one. Only
   * a starting value — an admin can replace it for a one-off. */
  defaultMeetingUrl?: string;
  onOpenChange: (open: boolean) => void;
  onCreated: () => void;
}) {
  // Derived from the slot itself (not a separately-tracked value) so it can
  // never drift from what was actually searched for this slot.
  const durationMinutes = Math.round((slot.endUnix - slot.startUnix) / 60);

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [meetingUrl, setMeetingUrl] = useState(defaultMeetingUrl);
  // Off unless asked for. Most sessions are one-offs; a recurring 1:1 is the
  // Nexus Partner's monthly rhythm with a member.
  const [repeats, setRepeats] = useState(false);
  const [repeatEveryWeeks, setRepeatEveryWeeks] = useState(4);
  const [repeatCount, setRepeatCount] = useState(6);
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
          advisorMemberId,
          title,
          description: description || undefined,
          meetingUrl: meetingUrl || undefined,
          startsAtUnix: slot.startUnix,
          durationMinutes,
          timezone,
          ...(repeats ? { repeatEveryWeeks, repeatCount } : {}),
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
          <div className="space-y-2 rounded-lg border border-border p-3">
            <label className="flex items-center gap-2 text-sm text-foreground">
              <Checkbox checked={repeats} onCheckedChange={(v) => setRepeats(v === true)} />
              Repeat this session
            </label>
            {repeats && (
              <>
                <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                  <span>Every</span>
                  <Select
                    items={{ "2": "2 weeks", "4": "4 weeks" }}
                    value={String(repeatEveryWeeks)}
                    onValueChange={(v) => v && setRepeatEveryWeeks(Number(v))}
                  >
                    <SelectTrigger className="w-28">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="2">2 weeks</SelectItem>
                      <SelectItem value="4">4 weeks</SelectItem>
                    </SelectContent>
                  </Select>
                  <span>for</span>
                  <Select
                    items={Object.fromEntries(REPEAT_COUNTS.map((n) => [String(n), `${n} sessions`]))}
                    value={String(repeatCount)}
                    onValueChange={(v) => v && setRepeatCount(Number(v))}
                  >
                    <SelectTrigger className="w-36">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {REPEAT_COUNTS.map((n) => (
                        <SelectItem key={n} value={String(n)}>
                          {n} sessions
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                {/* Said before booking rather than discovered afterwards: every
                    date is checked, and one invitation covers the series. */}
                <p className="text-xs text-muted-foreground">
                  Every date is checked before anything is booked. Everyone gets one invitation for
                  the whole series — skipping or moving a single date is done in the calendar
                  itself.
                </p>
              </>
            )}
          </div>

          <div className="grid grid-cols-2 gap-4 rounded-lg border border-border bg-secondary/40 p-3 text-sm">
            <div>
              <p className="text-xs text-muted-foreground">Session lead</p>
              <p className="text-foreground">{organizerName}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">
                Founder{guestNames.length === 1 ? "" : "s"}
              </p>
              <p className="text-foreground">{guestNames.join(", ")}</p>
            </div>
            {/* Only shown when there is one — an empty "Advisor: —" row is
                noise on the majority of bookings. */}
            {advisorName && (
              <div>
                <p className="text-xs text-muted-foreground">Advisor</p>
                <p className="text-foreground">{advisorName}</p>
              </div>
            )}
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
