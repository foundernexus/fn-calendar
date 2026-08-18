"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { TimezoneSelect } from "@/components/timezone-select";
import { TimeSelect } from "@/components/time-select";
import { isSupportedTimezone } from "@/lib/timezones";

type Block = { startTime: string; endTime: string };
type DayState = { enabled: boolean; blocks: Block[] };

/** Mirrors MAX_BLOCKS_PER_DAY in api/me/route.ts — the server rejects more, so
 * the "Add block" button has to stop offering them at the same number. */
const MAX_BLOCKS_PER_DAY = 3;
const DEFAULT_BLOCK: Block = { startTime: "09:00", endTime: "17:00" };
/** Offered as the second block, since split days are nearly always a lunch
 * break — saves the member fiddling with two dropdowns to get the common case. */
const DEFAULT_SECOND_BLOCK: Block = { startTime: "14:00", endTime: "17:00" };

// Display order is Monday-first (matches the reference UI); storage/wire
// format stays 0=Sunday..6=Saturday everywhere else in this codebase (see
// dayOfWeek() in src/lib/time.ts) — this is purely a rendering order.
const DISPLAY_ORDER = [1, 2, 3, 4, 5, 6, 0];
const DAY_LABELS: Record<number, string> = {
  0: "Sun",
  1: "Mon",
  2: "Tue",
  3: "Wed",
  4: "Thu",
  5: "Fri",
  6: "Sat",
};
const DAY_LABELS_FULL: Record<number, string> = {
  0: "Sunday",
  1: "Monday",
  2: "Tuesday",
  3: "Wednesday",
  4: "Thursday",
  5: "Friday",
  6: "Saturday",
};

const PROVIDER_LABELS: Record<string, string> = {
  google: "Google Calendar",
  microsoft: "Microsoft/Outlook",
  icloud: "iCloud",
};
function providerLabel(provider: string) {
  return PROVIDER_LABELS[provider] ?? provider.charAt(0).toUpperCase() + provider.slice(1);
}

function defaultDays(initial: { dayOfWeek: number; startTime: string; endTime: string }[]) {
  const byDay = new Map<number, Block[]>();
  for (const row of initial) {
    const list = byDay.get(row.dayOfWeek) ?? [];
    list.push({ startTime: row.startTime, endTime: row.endTime });
    byDay.set(row.dayOfWeek, list);
  }

  const days: Record<number, DayState> = {};
  for (let d = 0; d < 7; d++) {
    const existing = byDay.get(d);
    days[d] = existing?.length
      ? // Sorted because the rows come back in insertion order, and a member
        // who added an early-morning block second would otherwise see their
        // day listed out of order.
        { enabled: true, blocks: [...existing].sort((a, b) => a.startTime.localeCompare(b.startTime)) }
      : { enabled: false, blocks: [{ ...DEFAULT_BLOCK }] };
  }
  return days;
}

export function MemberSettingsForm({
  fullName,
  timezone: initialTimezone,
  weeklySessionCap: initialCap,
  initialAvailability,
  connection: initialConnection,
  needsReconnect,
}: {
  fullName: string;
  timezone: string | null;
  weeklySessionCap: number;
  initialAvailability: { dayOfWeek: number; startTime: string; endTime: string }[];
  connection: { provider: string; grantEmail: string } | null;
  /** They were connected before, but that connection now belongs to a
   * different Nylas app (e.g. we switched Sandbox/Production tiers) and no
   * longer works — distinct from never having connected at all, so the copy
   * below can say "reconnect" instead of implying something's wrong with
   * their calendar itself. */
  needsReconnect: boolean;
}) {
  // Only ever suggests a browser-detected default when nothing's been saved
  // yet (initialTimezone is null) — never overwrites a timezone the member
  // already chose. Computed as the initial state itself, not in an effect —
  // this is picking a default value, not synchronizing with an external
  // system, so there's no reason to force an extra render to arrive at it.
  const [timezone, setTimezone] = useState(() => {
    if (initialTimezone) return initialTimezone;
    try {
      const detected = Intl.DateTimeFormat().resolvedOptions().timeZone;
      return detected && isSupportedTimezone(detected) ? detected : null;
    } catch {
      // Intl not available for some reason — leave it unset, the member can
      // still pick one manually.
      return null;
    }
  });
  const [weeklySessionCap, setWeeklySessionCap] = useState(initialCap);
  const [days, setDays] = useState<Record<number, DayState>>(() =>
    defaultDays(initialAvailability)
  );
  const [connection, setConnection] = useState(initialConnection);
  const [submitting, setSubmitting] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);

  function updateDay(day: number, patch: Partial<DayState>) {
    setDays((prev) => ({ ...prev, [day]: { ...prev[day], ...patch } }));
  }

  function updateBlock(day: number, index: number, patch: Partial<Block>) {
    setDays((prev) => ({
      ...prev,
      [day]: {
        ...prev[day],
        blocks: prev[day].blocks.map((b, i) => (i === index ? { ...b, ...patch } : b)),
      },
    }));
  }

  function addBlock(day: number) {
    setDays((prev) => ({
      ...prev,
      [day]: { ...prev[day], blocks: [...prev[day].blocks, { ...DEFAULT_SECOND_BLOCK }] },
    }));
  }

  function removeBlock(day: number, index: number) {
    setDays((prev) => ({
      ...prev,
      [day]: { ...prev[day], blocks: prev[day].blocks.filter((_, i) => i !== index) },
    }));
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (!timezone) {
      toast.error("Pick your timezone.");
      return;
    }
    const availability = DISPLAY_ORDER.filter((d) => days[d].enabled).flatMap((d) =>
      days[d].blocks.map((b) => ({
        dayOfWeek: d,
        startTime: b.startTime,
        endTime: b.endTime,
      }))
    );

    // Same two rules the server enforces, checked here first so the member
    // gets a message naming the day instead of a rejected save.
    for (const a of availability) {
      if (a.endTime <= a.startTime) {
        toast.error(`${DAY_LABELS_FULL[a.dayOfWeek]}: end time must be after start time.`);
        return;
      }
    }
    for (const day of DISPLAY_ORDER) {
      if (!days[day].enabled) continue;
      const sorted = [...days[day].blocks].sort((a, b) => a.startTime.localeCompare(b.startTime));
      for (let i = 1; i < sorted.length; i++) {
        if (sorted[i].startTime < sorted[i - 1].endTime) {
          toast.error(`${DAY_LABELS_FULL[day]}: time blocks overlap.`);
          return;
        }
      }
    }

    setSubmitting(true);
    try {
      const res = await fetch("/api/me", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ timezone, weeklySessionCap, availability }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? "Something went wrong. Please try again.");
        return;
      }
      toast.success("Saved.");
    } catch {
      toast.error("Something went wrong. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleReconnect() {
    setReconnecting(true);
    try {
      const res = await fetch("/api/me/reconnect", { method: "POST" });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? "Something went wrong. Please try again.");
        setReconnecting(false);
        return;
      }
      window.location.href = data.url;
    } catch {
      toast.error("Something went wrong. Please try again.");
      setReconnecting(false);
    }
  }

  async function handleDisconnect() {
    setSubmitting(true);
    try {
      const res = await fetch("/api/me/disconnect", { method: "POST" });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? "Something went wrong. Please try again.");
        return;
      }
      setConnection(null);
      toast.success("Calendar disconnected.");
    } catch {
      toast.error("Something went wrong. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSave}>
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[300px_1fr]">
        {/* Left: identity, connection, timezone, cap — one consolidated card */}
        <div className="space-y-5 rounded-lg border border-border bg-card p-5 shadow-card">
          <div>
            <p className="text-sm font-medium text-foreground">{fullName}</p>
            {connection ? (
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                <Badge className="bg-accent text-accent-foreground">Connected</Badge>
                <span className="text-xs text-muted-foreground">
                  {providerLabel(connection.provider)} — {connection.grantEmail}
                </span>
              </div>
            ) : needsReconnect ? (
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                <Badge className="bg-secondary text-secondary-foreground">Needs reconnect</Badge>
                <span className="text-xs text-muted-foreground">
                  Your calendar connection is out of date — reconnect below.
                </span>
              </div>
            ) : (
              <p className="mt-2 text-xs text-destructive">Not connected.</p>
            )}
            <div className="mt-3 flex gap-2">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={handleReconnect}
                disabled={reconnecting}
              >
                {connection || needsReconnect ? "Reconnect" : "Connect calendar"}
              </Button>
              {(connection || needsReconnect) && (
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={handleDisconnect}
                  disabled={submitting}
                >
                  Disconnect
                </Button>
              )}
            </div>
          </div>

          <div className="border-t border-border pt-5">
            <Label htmlFor="timezone">Your timezone</Label>
            <div className="mt-2">
              <TimezoneSelect id="timezone" value={timezone} onChange={setTimezone} />
            </div>
          </div>

          <div className="border-t border-border pt-5">
            <Label htmlFor="weekly-cap">Sessions per week</Label>
            <p className="mt-1 text-xs text-muted-foreground">
              The most sessions you&apos;re willing to take on in a given week.
            </p>
            <Input
              id="weekly-cap"
              type="number"
              min={0}
              max={50}
              value={weeklySessionCap}
              onChange={(e) => setWeeklySessionCap(Number(e.target.value))}
              className="mt-2 w-24"
            />
          </div>
        </div>

        {/* Right: weekly availability */}
        <div className="rounded-lg border border-border bg-card p-5 shadow-card">
          <Label>Weekly availability</Label>
          <div className="mt-3 divide-y divide-border">
            {DISPLAY_ORDER.map((day) => {
              const d = days[day];
              return (
                <div
                  key={day}
                  className="grid grid-cols-[auto_2.75rem_1fr] items-start gap-3 py-2 first:pt-0 last:pb-0"
                >
                  <Switch
                    className="mt-1"
                    checked={d.enabled}
                    onCheckedChange={(checked) => updateDay(day, { enabled: checked })}
                  />
                  <span className="mt-1.5 text-sm text-foreground">{DAY_LABELS[day]}</span>
                  {d.enabled ? (
                    // Wrap rather than a hard column: on a wide screen two
                    // blocks sit side by side, on a narrow one they stack.
                    // Each block is two selects plus a remove button, so a
                    // fixed row would overflow the card on mobile — which is
                    // why Calendly and Cal.com stack theirs unconditionally.
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                      {d.blocks.map((block, index) => (
                        <div key={index} className="flex items-center gap-2">
                          <TimeSelect
                            value={block.startTime}
                            onChange={(startTime) => updateBlock(day, index, { startTime })}
                          />
                          <span className="text-muted-foreground">–</span>
                          <TimeSelect
                            value={block.endTime}
                            onChange={(endTime) => updateBlock(day, index, { endTime })}
                          />
                          {/* Never offer to remove the last block — an enabled
                              day with zero blocks would silently save as "off". */}
                          {d.blocks.length > 1 && (
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              aria-label={`Remove this time block on ${DAY_LABELS_FULL[day]}`}
                              onClick={() => removeBlock(day, index)}
                            >
                              ✕
                            </Button>
                          )}
                        </div>
                      ))}
                      {d.blocks.length < MAX_BLOCKS_PER_DAY && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="px-0 text-muted-foreground"
                          onClick={() => addBlock(day)}
                        >
                          + Add block
                        </Button>
                      )}
                    </div>
                  ) : (
                    <span className="mt-1.5 block text-sm text-muted-foreground">Unavailable</span>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>

      <div className="mt-5 flex justify-end">
        <Button type="submit" disabled={submitting}>
          {submitting ? "Saving…" : "Save"}
        </Button>
      </div>
    </form>
  );
}
