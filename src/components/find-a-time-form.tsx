"use client";

import { useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  ResultsList,
  type AvailabilityResult,
  type Slot,
  type SearchedParams,
} from "@/components/results-list";
import { CreateEventDialog } from "@/components/create-event-dialog";
import type { MemberWithConnection } from "@/db/queries";
import { TIMEZONES } from "@/lib/time";
import { isValidEmail, normalizeEmail } from "@/lib/email";

const DURATIONS = [30, 45, 60] as const;

/** Local date, not UTC — `toISOString()` would return tomorrow's date for
 * anyone west of UTC in the evening (e.g. 6pm PT is already after midnight
 * UTC), silently dropping "today" from the default range. */
function defaultDateString(daysFromNow: number) {
  const d = new Date();
  d.setDate(d.getDate() + daysFromNow);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** Splits free-typed guest input on commas, semicolons, or newlines, trims,
 * lowercases, and dedupes — order-preserving so the dialog's guest list
 * matches what the admin typed. */
function parseGuestEmails(text: string): string[] {
  return Array.from(
    new Set(
      text
        .split(/[,;\n]+/)
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean)
    )
  );
}

/** Parses + validates the guest textarea, toasting and returning null on the
 * first problem. Run twice: once at search time (early feedback) and again
 * at slot-click time (authoritative — guests don't affect the availability
 * grid, so the admin can freely edit the list between searching and
 * clicking a slot, and the click must validate what's there *then*, not
 * whatever was typed when the search ran). 49 = Nylas's 50-participant cap
 * minus the organizer, who's always added separately server-side. */
function validateGuestEmails(text: string): string[] | null {
  const guestEmails = parseGuestEmails(text);
  if (guestEmails.length === 0) {
    toast.error("Add at least one guest email.");
    return null;
  }
  const invalid = guestEmails.find((email) => !isValidEmail(email));
  if (invalid) {
    toast.error(`"${invalid}" doesn't look like a valid email.`);
    return null;
  }
  if (guestEmails.length > 49) {
    toast.error("Add at most 49 guests.");
    return null;
  }
  return guestEmails;
}

export function FindATimeForm({ members }: { members: MemberWithConnection[] }) {
  const connectedMembers = members.filter((m) => m.connected);

  const [organizerMemberId, setOrganizerMemberId] = useState<string>(
    connectedMembers[0] ? String(connectedMembers[0].id) : ""
  );
  const [guestEmailsText, setGuestEmailsText] = useState("");
  const [startDate, setStartDate] = useState(defaultDateString(0));
  const [endDate, setEndDate] = useState(defaultDateString(14));
  const [durationMinutes, setDurationMinutes] = useState(60);
  const [workingHoursStart, setWorkingHoursStart] = useState("09:00");
  const [workingHoursEnd, setWorkingHoursEnd] = useState("17:00");
  const [timezone, setTimezone] = useState<string>(TIMEZONES[0].value);
  const [excludeWeekends, setExcludeWeekends] = useState(true);

  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<AvailabilityResult | null>(null);
  const [dialogSlot, setDialogSlot] = useState<Slot | null>(null);
  // The guest list the dialog will actually use — captured fresh at the
  // moment a grid cell is clicked (see handleSelectSlot), not at search
  // time, since guests have no effect on the availability grid and can be
  // freely edited between searching and picking a slot.
  const [dialogGuestEmails, setDialogGuestEmails] = useState<string[]>([]);
  // Snapshotted at search time, NOT read live from the form above — every
  // field here can change after a search completes while the grid is still
  // showing the old search's results. Without this, the grid could render
  // against a range/timezone/lead it was never actually searched for.
  const [searchedParams, setSearchedParams] = useState<SearchedParams | null>(null);

  async function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    if (!organizerMemberId) {
      toast.error("Pick who's leading this session.");
      return;
    }
    // Just an early check here — guests don't affect the search, so this
    // isn't sent to the API and isn't the authoritative validation (that
    // happens again in handleSelectSlot, against whatever's typed by then).
    if (!validateGuestEmails(guestEmailsText)) return;

    const organizer = connectedMembers.find((m) => String(m.id) === organizerMemberId);
    if (!organizer) {
      toast.error("Pick who's leading this session.");
      return;
    }

    setLoading(true);
    setResult(null);
    try {
      const res = await fetch("/api/admin/availability", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          organizerMemberId: Number(organizerMemberId),
          startDate,
          endDate,
          durationMinutes,
          workingHoursStart,
          workingHoursEnd,
          timezone,
          excludeWeekends,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? "Something went wrong. Please try again.");
        return;
      }
      setResult(data);
      setSearchedParams({
        organizerMemberId: Number(organizerMemberId),
        organizerName: organizer.fullName,
        startDate,
        endDate,
        workingHoursStart,
        workingHoursEnd,
        excludeWeekends,
        timezone,
      });
    } catch {
      toast.error("Something went wrong. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  function handleSelectSlot(slot: Slot) {
    const guestEmails = validateGuestEmails(guestEmailsText);
    if (!guestEmails) return;

    // Mirrors the server's own dedup (src/app/api/admin/events/route.ts) so
    // the dialog's guest preview matches what's actually invited — otherwise
    // an admin who typed the lead's own address by mistake would see it
    // listed as a guest here even though the server silently drops it there.
    const organizer = members.find((m) => m.id === searchedParams?.organizerMemberId);
    const filtered = organizer
      ? guestEmails.filter((email) => email !== normalizeEmail(organizer.email))
      : guestEmails;
    if (filtered.length === 0) {
      toast.error("That's the session lead's own address — add at least one other guest.");
      return;
    }

    setDialogGuestEmails(filtered);
    setDialogSlot(slot);
  }

  return (
    <div className="space-y-8">
      <form
        onSubmit={handleSearch}
        className="space-y-6 rounded-lg border border-border bg-card p-6 shadow-card"
      >
        <div className="space-y-2">
          <Label>Session lead</Label>
          <Select
            items={Object.fromEntries(connectedMembers.map((m) => [String(m.id), m.fullName]))}
            value={organizerMemberId}
            onValueChange={(v) => v && setOrganizerMemberId(v)}
          >
            <SelectTrigger className="w-full">
              <SelectValue placeholder="Who's leading this session?" />
            </SelectTrigger>
            <SelectContent>
              {connectedMembers.map((m) => (
                <SelectItem key={m.id} value={String(m.id)}>
                  {m.fullName}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {connectedMembers.length === 0 && (
            <p className="text-sm text-destructive">
              No connected calendars yet —{" "}
              <Link href="/connect" className="underline">
                connect one
              </Link>{" "}
              first.
            </p>
          )}
        </div>

        <div className="space-y-2">
          <Label htmlFor="guest-emails">Guest emails</Label>
          <Textarea
            id="guest-emails"
            value={guestEmailsText}
            onChange={(e) => setGuestEmailsText(e.target.value)}
            placeholder="jane@example.com, expert@example.com"
          />
          <p className="text-xs text-muted-foreground">
            Separate multiple emails with a comma or newline.
          </p>
        </div>

        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
          <div className="space-y-2">
            <Label htmlFor="start-date">Start date</Label>
            <Input
              id="start-date"
              type="date"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="end-date">End date</Label>
            <Input
              id="end-date"
              type="date"
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label>Duration</Label>
            <Select
              items={Object.fromEntries(DURATIONS.map((d) => [String(d), `${d} min`]))}
              value={String(durationMinutes)}
              onValueChange={(v) => v && setDurationMinutes(Number(v))}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {DURATIONS.map((d) => (
                  <SelectItem key={d} value={String(d)}>
                    {d} min
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>Timezone</Label>
            <Select
              items={Object.fromEntries(TIMEZONES.map((tz) => [tz.value, tz.label]))}
              value={timezone}
              onValueChange={(v) => v && setTimezone(v)}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TIMEZONES.map((tz) => (
                  <SelectItem key={tz.value} value={tz.value}>
                    {tz.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="hours-start">Working hours start</Label>
            <Input
              id="hours-start"
              type="time"
              step={1800}
              value={workingHoursStart}
              onChange={(e) => setWorkingHoursStart(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="hours-end">Working hours end</Label>
            <Input
              id="hours-end"
              type="time"
              step={1800}
              value={workingHoursEnd}
              onChange={(e) => setWorkingHoursEnd(e.target.value)}
            />
          </div>
        </div>

        <label className="flex items-center gap-2 text-sm text-foreground">
          <Checkbox
            checked={excludeWeekends}
            onCheckedChange={(checked) => setExcludeWeekends(!!checked)}
          />
          Exclude weekends
        </label>

        <Button type="submit" disabled={loading}>
          {loading ? "Searching…" : "Find a time"}
        </Button>
      </form>

      {result && searchedParams && (
        <ResultsList result={result} searchedParams={searchedParams} onSelectSlot={handleSelectSlot} />
      )}

      {dialogSlot && searchedParams && (
        <CreateEventDialog
          slot={dialogSlot}
          organizerMemberId={searchedParams.organizerMemberId}
          organizerName={searchedParams.organizerName}
          guestEmails={dialogGuestEmails}
          timezone={searchedParams.timezone}
          onOpenChange={(open) => {
            if (!open) setDialogSlot(null);
          }}
          onCreated={() => setDialogSlot(null)}
        />
      )}
    </div>
  );
}
