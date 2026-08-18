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
import { AddGuestDialog } from "@/components/add-guest-dialog";
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

export function FindATimeForm({
  members: initialMembers,
  connectUrl,
}: {
  members: MemberWithConnection[];
  connectUrl: string;
}) {
  // Lifted into state so a newly-added guest (AddGuestDialog) is reflected
  // immediately without a full page reload — though since they start out not
  // connected, they won't actually appear in connectedMembers/facilitators
  // below until they connect a calendar themselves.
  const [members, setMembers] = useState(initialMembers);
  const connectedMembers = members.filter((m) => m.connected);
  // Previously connected under a different Nylas app (e.g. we switched
  // Sandbox/Production tiers) — their old connection no longer works, but
  // they shouldn't look identical to someone who's simply never connected.
  const needsReconnectMembers = members.filter((m) => m.needsReconnect);
  // Session lead is a curated subset — connecting a calendar makes someone
  // eligible as a guest, not automatically eligible to lead a session.
  const facilitators = connectedMembers.filter((m) => m.isFacilitator);
  // Same idea as facilitators: a curated subset, not everyone connected.
  const advisors = connectedMembers.filter((m) => m.isAdvisor);

  const [organizerMemberId, setOrganizerMemberId] = useState<number | null>(
    facilitators[0]?.id ?? null
  );
  // Optional — most sessions won't have one.
  const [advisorMemberId, setAdvisorMemberId] = useState<number | null>(null);
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
  // The exact request body of the last search, replayed after a booking to
  // refresh the grid. Kept separately from `searchedParams` (which exists for
  // rendering) because the refetch has to send precisely what was searched —
  // including durationMinutes, which the render snapshot doesn't carry.
  const [lastSearchBody, setLastSearchBody] = useState<Record<string, unknown> | null>(null);
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

    const organizer = facilitators.find((m) => m.id === organizerMemberId);
    if (!organizer) {
      toast.error("Pick who's leading this session.");
      return;
    }

    const body = {
      organizerMemberId,
      advisorMemberId,
      guestMemberIds,
      startDate,
      endDate,
      durationMinutes,
      workingHoursStart,
      workingHoursEnd,
      timezone,
      excludeWeekends,
    };

    setLoading(true);
    setResult(null);
    try {
      const res = await fetch("/api/admin/availability", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? "Something went wrong. Please try again.");
        return;
      }
      setResult(data);
      setLastSearchBody(body);
      setSearchedParams({
        organizerMemberId,
        organizerName: organizer.fullName,
        advisorMemberId,
        advisorName: advisors.find((m) => m.id === advisorMemberId)?.fullName ?? null,
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

  /** Replays the last search after a booking so the just-booked slot shows as
   * taken straight away, instead of the admin having to reload the page.
   *
   * Deliberately replays `lastSearchBody` rather than the live form fields —
   * those can have been edited since the search, and re-running with them
   * would swap the grid out for a different range or guest list than the one
   * the admin is currently looking at. Same reasoning as the searchedParams
   * snapshot above.
   *
   * Doesn't clear `result` first, so the grid stays on screen while this runs
   * and the row just booked doesn't flash away and back. */
  async function refreshResultsAfterBooking() {
    if (!lastSearchBody) return;
    try {
      const res = await fetch("/api/admin/availability", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(lastSearchBody),
      });
      const data = await res.json();
      if (!res.ok) {
        // The booking itself already succeeded — say that, so a failed refresh
        // doesn't read like a failed booking and prompt a duplicate attempt.
        toast.error("Session booked, but the grid couldn't refresh. Reload to see it.");
        return;
      }
      setResult(data);
    } catch {
      toast.error("Session booked, but the grid couldn't refresh. Reload to see it.");
    }
  }

  return (
    <div className="space-y-8">
      <p
        className="text-sm text-muted-foreground"
      >
        {connectedMembers.length} calendar{connectedMembers.length === 1 ? "" : "s"} connected
      </p>
      {needsReconnectMembers.length > 0 && (
        <div className="rounded-lg border border-border bg-secondary p-4 text-sm text-secondary-foreground">
          <p className="font-medium">
            {needsReconnectMembers.length === 1
              ? "1 member needs to reconnect their calendar"
              : `${needsReconnectMembers.length} members need to reconnect their calendars`}
          </p>
          <p className="mt-1 text-muted-foreground">
            {needsReconnectMembers.map((m) => m.fullName).join(", ")} — connected under a
            previous setup that&apos;s no longer active, so they&apos;re excluded from the
            pickers below until they reconnect on their own /me page.
          </p>
        </div>
      )}
      <form
        onSubmit={handleSearch}
        className="space-y-6 rounded-lg border border-border bg-card p-6 shadow-card"
      >
        <div className="space-y-2">
          <Label htmlFor="session-lead">Session lead</Label>
          <MemberSelect
            id="session-lead"
            members={facilitators}
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
            emptyText="No matching facilitators — they may be connected but not set up to lead sessions."
          />
          {facilitators.length === 0 && (
            <p className="text-sm text-destructive">
              No facilitators have connected their calendar yet.
            </p>
          )}
        </div>

        <div className="space-y-2">
          <Label htmlFor="advisor">Advisor (optional)</Label>
          <MemberSelect
            id="advisor"
            members={advisors}
            value={advisorMemberId}
            onChange={(id) => {
              setAdvisorMemberId(id);
              // Same reasoning as the session lead: the guest multi-select
              // hides whoever's picked here, so a stale selection would sit
              // invisibly in state. The server rejects advisor-also-guest
              // anyway (event_attendees is unique per member per event), but
              // it should never get that far.
              if (id) setGuestMemberIds((ids) => ids.filter((gid) => gid !== id));
            }}
            placeholder="Add an advisor to this session?"
            emptyText="No connected advisors — mark someone as an advisor when adding them."
          />
          <p className="text-xs text-muted-foreground">
            Their calendar is checked like everyone else&apos;s, and they&apos;ll see the session on
            their advisor dashboard. Pick the same person again to clear this.
          </p>
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label htmlFor="guests">Guests</Label>
            <AddGuestDialog
              connectUrl={connectUrl}
              onAdded={(member) => setMembers((prev) => [...prev, member])}
            />
          </div>
          <MemberMultiSelect
            id="guests"
            members={connectedMembers}
            value={guestMemberIds}
            onChange={setGuestMemberIds}
            excludeId={organizerMemberId}
            excludeIds={advisorMemberId ? [advisorMemberId] : undefined}
            placeholder="Who's this session for?"
          />
          {connectedMembers.length === 0 ? (
            <p className="text-sm text-destructive">
              No one&apos;s connected a calendar yet —{" "}
              <Link href="/connect" className="underline">
                connect one
              </Link>{" "}
              first.
            </p>
          ) : (
            <p className="text-xs text-muted-foreground">
              Only people who&apos;ve connected their calendar can be selected — that&apos;s what
              makes the grid below meaningful.
            </p>
          )}
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
          advisorMemberId={searchedParams.advisorMemberId ?? null}
          advisorName={searchedParams.advisorName ?? null}
          guestMemberIds={searchedParams.guestMemberIds}
          guestNames={searchedParams.guestMemberIds.map(
            (id) => members.find((m) => m.id === id)?.fullName ?? `Member #${id}`
          )}
          timezone={searchedParams.timezone}
          onOpenChange={(open) => {
            if (!open) setDialogSlot(null);
          }}
          onCreated={() => {
            setDialogSlot(null);
            void refreshResultsAfterBooking();
          }}
        />
      )}
    </div>
  );
}
