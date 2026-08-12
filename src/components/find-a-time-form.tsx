"use client";

import { useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { MemberSelect, MemberMultiSelect } from "@/components/member-picker";
import {
  ResultsList,
  type AvailabilityResult,
  type Slot,
  type SearchedParams,
} from "@/components/results-list";
import { CreateEventDialog } from "@/components/create-event-dialog";
import type { MemberWithConnection } from "@/db/queries";
import { TIMEZONES } from "@/lib/time";

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

export function FindATimeForm({ members }: { members: MemberWithConnection[] }) {
  const connectedMembers = members.filter((m) => m.connected);

  const [organizerMemberId, setOrganizerMemberId] = useState<number | null>(
    connectedMembers[0]?.id ?? null
  );
  const [guestMemberIds, setGuestMemberIds] = useState<number[]>([]);
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
  // Snapshotted at search time, NOT read live from the form above — every
  // field here can change after a search completes while the grid is still
  // showing the old search's results. Without this, the grid could render
  // against a range/timezone/lead/guest-list it was never actually searched
  // for, and the dialog could create an event for a group that was never
  // checked.
  const [searchedParams, setSearchedParams] = useState<SearchedParams | null>(null);

  async function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    if (!organizerMemberId) {
      toast.error("Pick who's leading this session.");
      return;
    }
    if (guestMemberIds.length === 0) {
      toast.error("Add at least one guest.");
      return;
    }

    const organizer = connectedMembers.find((m) => m.id === organizerMemberId);
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
          organizerMemberId,
          guestMemberIds,
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
        organizerMemberId,
        organizerName: organizer.fullName,
        guestMemberIds,
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

  return (
    <div className="space-y-8">
      <form
        onSubmit={handleSearch}
        className="space-y-6 rounded-lg border border-border bg-card p-6 shadow-card"
      >
        <div className="space-y-2">
          <Label htmlFor="session-lead">Session lead</Label>
          <MemberSelect
            id="session-lead"
            members={connectedMembers}
            value={organizerMemberId}
            onChange={(id) => {
              setOrganizerMemberId(id);
              // The multi-select hides whoever's picked as lead from its own
              // list (and its trigger label), so a stale selection here
              // would otherwise sit invisibly in state — silently shrinking
              // the guest list to just the new lead with no sign of it.
              setGuestMemberIds((ids) => ids.filter((gid) => gid !== id));
            }}
            placeholder="Who's leading this session?"
          />
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
          <Label htmlFor="guests">Guests</Label>
          <MemberMultiSelect
            id="guests"
            members={connectedMembers}
            value={guestMemberIds}
            onChange={setGuestMemberIds}
            excludeId={organizerMemberId}
            placeholder="Who's this session for?"
          />
          <p className="text-xs text-muted-foreground">
            Only people who&apos;ve connected their calendar can be selected — that&apos;s what
            makes the grid below meaningful.
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
        <ResultsList result={result} searchedParams={searchedParams} onSelectSlot={setDialogSlot} />
      )}

      {dialogSlot && searchedParams && (
        <CreateEventDialog
          slot={dialogSlot}
          organizerMemberId={searchedParams.organizerMemberId}
          organizerName={searchedParams.organizerName}
          guestMemberIds={searchedParams.guestMemberIds}
          guestNames={searchedParams.guestMemberIds.map(
            (id) => members.find((m) => m.id === id)?.fullName ?? `Member #${id}`
          )}
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
