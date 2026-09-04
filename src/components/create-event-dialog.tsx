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

/** How long a series runs. Twelve four-weekly is roughly a year; "forever" is
 * the standing 1:1 that nobody intends to stop, and re-booking every twelve
 * months is admin nobody was asking for. */
const REPEAT_OPTIONS = {
  "3": "3 sessions",
  "6": "6 sessions",
  "12": "12 sessions",
  forever: "Until cancelled",
} as const;

type RepeatFor = keyof typeof REPEAT_OPTIONS;

const WEEKDAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];
const ORDINAL_NAMES = ["", "first", "second", "third", "fourth"];

/** The repeat choices, phrased the way Google phrases them for the date that
 * was actually picked.
 *
 * Google writes out the full sentence — "Monthly on the fourth Friday" — rather
 * than making you assemble it, and that is the whole reason nobody is surprised
 * by what they get. The four-weekly option is the one that needs the warning,
 * because "every 4 weeks" reads like "monthly" and is not: 28 days is short of
 * every month, so the date walks backwards out of it.
 *
 * "Last" is only offered when the chosen date really is the last of its weekday
 * in the month — offering it otherwise would silently move the first session. */
function repeatChoicesFor(startUnix: number, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(startUnix * 1000));
  const [year, month, day] = parts.split("-").map(Number);
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  const ordinal = Math.ceil(day / 7);
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const isLast = day + 7 > daysInMonth;
  const name = WEEKDAY_NAMES[weekday];

  const choices: { value: string; label: string; note?: string }[] = [
    { value: "weekly-2", label: `Every 2 weeks on ${name}` },
    {
      value: "weekly-4",
      label: `Every 4 weeks on ${name}`,
      note: "Every 28 days — this drifts out of the month over time.",
    },
  ];
  if (ordinal <= 4) {
    choices.push({
      value: `monthly-${ordinal}`,
      label: `Monthly on the ${ORDINAL_NAMES[ordinal]} ${name}`,
      note: "Keeps its place in the month. The gap is sometimes five weeks.",
    });
  }
  if (isLast) {
    choices.push({
      value: "monthly--1",
      label: `Monthly on the last ${name}`,
      note: "Keeps its place in the month. The gap is sometimes five weeks.",
    });
  }
  return { choices, weekday };
}

export function CreateEventDialog({
  slot,
  organizerMemberId,
  organizerName,
  advisorMemberId,
  advisorName,
  guestMemberIds,
  guestNames,
  notConnectedNames = [],
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
  /** Whoever on this session had no calendar to check. They are invited like
   * everyone else — this slot simply isn't known to be free for them, and this
   * is the last screen before it's booked, so it says so here rather than
   * leaving it behind on the results line. */
  notConnectedNames?: string[];
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

  // Who this booking would double-book, if anyone. Read off the slot rather than
  // passed in beside it, so the names shown here are necessarily the ones the
  // grid cell was drawn from and the ones sent to the server — three copies of
  // this list that could disagree is exactly how somebody gets double-booked
  // without it appearing on screen.
  const busyMemberIds = slot.busyMemberIds ?? [];
  const overBusy = busyMemberIds.length > 0;

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [meetingUrl, setMeetingUrl] = useState(defaultMeetingUrl);
  // Off unless asked for. Most sessions are one-offs; a recurring 1:1 is the
  // Nexus Partner's monthly rhythm with a member.
  const [repeats, setRepeats] = useState(false);
  const { choices: repeatChoices, weekday } = repeatChoicesFor(slot.startUnix, timezone);
  // Defaults to four-weekly, which is what every existing series uses. Changing
  // the default would quietly change the rhythm of sessions people book without
  // reading the dropdown.
  const [repeatPattern, setRepeatPattern] = useState("weekly-4");
  const [repeatFor, setRepeatFor] = useState<RepeatFor>("6");
  const chosenPattern = repeatChoices.find((c) => c.value === repeatPattern) ?? repeatChoices[0];
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
          // Omitted entirely when nobody is being booked over. The server treats
          // an absent field as "double-book nobody", so sending an empty array
          // would say the same thing more loudly — and a field that is only ever
          // present when it means something is harder to send by accident.
          ...(overBusy ? { overrideBusyMemberIds: busyMemberIds } : {}),
          // "Forever" is sent as its own flag rather than as a missing count.
          // A dropped field must read as "no repeat", never as "book this into
          // someone's calendar indefinitely".
          ...(repeats
            ? {
                ...(chosenPattern.value.startsWith("monthly")
                  ? {
                      repeatMonthlyOrdinal: Number(chosenPattern.value.slice("monthly-".length)),
                      repeatMonthlyWeekday: weekday,
                    }
                  : {
                      repeatEveryWeeks: Number(chosenPattern.value.slice("weekly-".length)),
                    }),
                ...(repeatFor === "forever"
                  ? { repeatForever: true }
                  : { repeatCount: Number(repeatFor) }),
              }
            : {}),
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
              placeholder="https://zoom.us/j/… (leave empty for Google Meet)"
            />
            {/* The empty field IS the switch, so it has to say so here. An
                introduction between two people who've never met is exactly the
                booking where nobody has a shared room to paste, and silently
                sending an invite with nowhere to meet is the failure this
                sentence prevents. */}
            <p className="text-xs text-muted-foreground">
              Leave this empty and Google Meet makes a fresh link for this session.
            </p>
          </div>
          {/* Not offered at all when booking over somebody, rather than offered
              and then refused by the server. Booking over a calendar is a
              decision about one afternoon that a person could see; the fourth
              date is four months out and nobody has seen it. */}
          {overBusy ? (
            <p className="rounded-lg border border-border p-3 text-xs text-muted-foreground">
              A session booked over someone&apos;s calendar can&apos;t repeat — this one date only.
            </p>
          ) : (
          <div className="space-y-2 rounded-lg border border-border p-3">
            <label className="flex items-center gap-2 text-sm text-foreground">
              <Checkbox checked={repeats} onCheckedChange={(v) => setRepeats(v === true)} />
              Repeat this session
            </label>
            {repeats && (
              <>
                <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                  <Select
                    items={Object.fromEntries(repeatChoices.map((c) => [c.value, c.label]))}
                    value={chosenPattern.value}
                    onValueChange={(v) => v && setRepeatPattern(v)}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {repeatChoices.map((c) => (
                        <SelectItem key={c.value} value={c.value}>
                          {c.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <span>for</span>
                  <Select
                    items={REPEAT_OPTIONS}
                    value={repeatFor}
                    onValueChange={(v) => v && setRepeatFor(v as RepeatFor)}
                  >
                    <SelectTrigger className="w-36">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {Object.entries(REPEAT_OPTIONS).map(([value, label]) => (
                        <SelectItem key={value} value={value}>
                          {label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                {/* Said before booking rather than discovered afterwards: what
                    gets checked, and that one invitation covers the series. */}
                {chosenPattern.note && (
                  <p className="text-xs text-muted-foreground">{chosenPattern.note}</p>
                )}
                <p className="text-xs text-muted-foreground">
                  {repeatFor === "forever"
                    ? "The first year of dates is checked before anything is booked. After that the series keeps going, and any clash that appears is flagged on the day it turns up."
                    : "Every date is checked before anything is booked."}{" "}
                  Everyone gets one invitation for the whole series — a single date can be moved or
                  dropped later without touching the rest.
                </p>
              </>
            )}
          </div>
          )}

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
            {/* Spans both columns and sits under the summary: it's a caveat
                about the people named above, not another field alongside
                them. */}
            {notConnectedNames.length > 0 && (
              <p className="col-span-2 text-xs text-muted-foreground">
                {notConnectedNames.join(", ")}{" "}
                {notConnectedNames.length === 1 ? "has no" : "have no"} calendar connected, so this
                time wasn&apos;t checked against theirs. They&apos;ll be invited and can decline.
              </p>
            )}
          </div>
          {/* Loud, and directly above the button that does it. This is the last
              screen before a second entry lands in somebody's calendar without
              anybody asking them, and naming them is what makes that a decision
              rather than an accident. */}
          {overBusy && (
            // Reassurance, not a warning. Reaching this dialog at all means the
            // only calendar in the way was the lead's own — the grid never
            // opens it otherwise — so the thing worth saying is that everybody
            // being invited IS free, and that the existing hold survives.
            <div className="rounded-lg border border-border bg-secondary/40 p-3 text-sm text-muted-foreground">
              You&apos;re already busy at this time
              {guestNames.length > 0 && <>, but {guestNames.join(", ")} {guestNames.length === 1 ? "is" : "are"} free</>}.
              This is booked alongside what&apos;s already in your calendar — that entry isn&apos;t
              touched, moved or cancelled.
            </div>
          )}
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
