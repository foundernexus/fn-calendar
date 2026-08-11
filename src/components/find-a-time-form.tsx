"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ResultsList, type AvailabilityResult, type Slot } from "@/components/results-list";
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
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
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
  // Snapshotted at search time, NOT read live from the form below — the
  // member selection or timezone can change after a search completes (e.g.
  // the admin unchecks someone, or flips the timezone dropdown) while the
  // results table is still showing the old search's slots. Without this, the
  // dialog would create an event for a group/timezone that was never actually
  // checked for that slot.
  const [searchedMemberIds, setSearchedMemberIds] = useState<number[]>([]);
  const [searchedTimezone, setSearchedTimezone] = useState<string>(timezone);

  function toggleMember(id: number) {
    setSelectedIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  async function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    if (selectedIds.length === 0) {
      toast.error("Select at least one member.");
      return;
    }
    setLoading(true);
    setResult(null);
    try {
      const res = await fetch("/api/admin/availability", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          memberIds: selectedIds,
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
      setSearchedMemberIds(selectedIds);
      setSearchedTimezone(timezone);
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
        <div>
          <Label>Members</Label>
          <div className="mt-2 space-y-2">
            {members.length === 0 && (
              <p className="text-sm text-muted-foreground">
                No members seeded yet — run `npm run db:seed`.
              </p>
            )}
            {members.map((m) => (
              <label key={m.id} className="flex items-center gap-3 text-sm">
                <Checkbox
                  checked={selectedIds.includes(m.id)}
                  onCheckedChange={() => toggleMember(m.id)}
                />
                <span className="text-foreground">{m.fullName}</span>
                <span className="text-muted-foreground">{m.email}</span>
                <Badge
                  className={
                    m.connected
                      ? "bg-accent text-accent-foreground"
                      : "bg-secondary text-secondary-foreground"
                  }
                >
                  {m.connected ? "Connected" : "Not connected"}
                </Badge>
              </label>
            ))}
          </div>
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
            <Select value={timezone} onValueChange={(v) => v && setTimezone(v)}>
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
              value={workingHoursStart}
              onChange={(e) => setWorkingHoursStart(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="hours-end">Working hours end</Label>
            <Input
              id="hours-end"
              type="time"
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

      {result && <ResultsList result={result} onSelectSlot={setDialogSlot} />}

      {dialogSlot && (
        <CreateEventDialog
          slot={dialogSlot}
          memberIds={searchedMemberIds}
          members={members}
          timezone={searchedTimezone}
          onOpenChange={(open) => {
            if (!open) setDialogSlot(null);
          }}
          onCreated={() => setDialogSlot(null)}
        />
      )}
    </div>
  );
}
