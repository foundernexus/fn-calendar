"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { TimezoneSelect } from "@/components/timezone-select";
import { isSupportedTimezone } from "@/lib/timezones";

type DayState = { enabled: boolean; startTime: string; endTime: string };

// Display order is Monday-first (matches the reference UI); storage/wire
// format stays 0=Sunday..6=Saturday everywhere else in this codebase (see
// dayOfWeek() in src/lib/time.ts) — this is purely a rendering order.
const DISPLAY_ORDER = [1, 2, 3, 4, 5, 6, 0];
const DAY_LABELS: Record<number, string> = {
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
  const byDay = new Map(initial.map((d) => [d.dayOfWeek, d]));
  const days: Record<number, DayState> = {};
  for (let d = 0; d < 7; d++) {
    const existing = byDay.get(d);
    days[d] = existing
      ? { enabled: true, startTime: existing.startTime, endTime: existing.endTime }
      : { enabled: false, startTime: "09:00", endTime: "17:00" };
  }
  return days;
}

export function MemberSettingsForm({
  fullName,
  timezone: initialTimezone,
  weeklySessionCap: initialCap,
  initialAvailability,
  connection: initialConnection,
}: {
  fullName: string;
  timezone: string | null;
  weeklySessionCap: number;
  initialAvailability: { dayOfWeek: number; startTime: string; endTime: string }[];
  connection: { provider: string; grantEmail: string } | null;
}) {
  const [timezone, setTimezone] = useState(initialTimezone);
  const [weeklySessionCap, setWeeklySessionCap] = useState(initialCap);
  const [days, setDays] = useState<Record<number, DayState>>(() =>
    defaultDays(initialAvailability)
  );
  const [connection, setConnection] = useState(initialConnection);
  const [submitting, setSubmitting] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);

  // Only ever suggests a default when nothing's been saved yet — never
  // overwrites a timezone the member already chose.
  useEffect(() => {
    if (timezone) return;
    try {
      const detected = Intl.DateTimeFormat().resolvedOptions().timeZone;
      if (detected && isSupportedTimezone(detected)) setTimezone(detected);
    } catch {
      // Intl not available for some reason — leave it unset, the member can
      // still pick one manually.
    }
  }, [timezone]);

  function updateDay(day: number, patch: Partial<DayState>) {
    setDays((prev) => ({ ...prev, [day]: { ...prev[day], ...patch } }));
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (!timezone) {
      toast.error("Pick your timezone.");
      return;
    }
    const availability = DISPLAY_ORDER.filter((d) => days[d].enabled).map((d) => ({
      dayOfWeek: d,
      startTime: days[d].startTime,
      endTime: days[d].endTime,
    }));
    for (const a of availability) {
      if (a.endTime <= a.startTime) {
        toast.error(`${DAY_LABELS[a.dayOfWeek]}: end time must be after start time.`);
        return;
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
    <form onSubmit={handleSave} className="space-y-8">
      <div className="rounded-lg border border-border bg-card p-6 shadow-card">
        <p className="text-sm font-medium text-foreground">{fullName}</p>
        {connection ? (
          <div className="mt-3 flex items-center gap-2">
            <Badge className="bg-accent text-accent-foreground">Connected</Badge>
            <span className="text-sm text-muted-foreground">
              {providerLabel(connection.provider)} — {connection.grantEmail}
            </span>
          </div>
        ) : (
          <p className="mt-3 text-sm text-destructive">Not connected.</p>
        )}
        <div className="mt-4 flex gap-2">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={handleReconnect}
            disabled={reconnecting}
          >
            {connection ? "Reconnect" : "Connect calendar"}
          </Button>
          {connection && (
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

      <div className="rounded-lg border border-border bg-card p-6 shadow-card">
        <Label htmlFor="timezone">Your timezone</Label>
        <div className="mt-2">
          <TimezoneSelect id="timezone" value={timezone} onChange={setTimezone} />
        </div>
      </div>

      <div className="rounded-lg border border-border bg-card p-6 shadow-card">
        <Label>Weekly availability</Label>
        <div className="mt-4 space-y-3">
          {DISPLAY_ORDER.map((day) => {
            const d = days[day];
            return (
              <div key={day} className="flex flex-wrap items-center gap-3">
                <Switch
                  checked={d.enabled}
                  onCheckedChange={(checked) => updateDay(day, { enabled: checked })}
                />
                <span className="w-24 text-sm text-foreground">{DAY_LABELS[day]}</span>
                {d.enabled ? (
                  <div className="flex items-center gap-2">
                    <Input
                      type="time"
                      value={d.startTime}
                      onChange={(e) => updateDay(day, { startTime: e.target.value })}
                      className="w-32"
                    />
                    <span className="text-muted-foreground">–</span>
                    <Input
                      type="time"
                      value={d.endTime}
                      onChange={(e) => updateDay(day, { endTime: e.target.value })}
                      className="w-32"
                    />
                  </div>
                ) : (
                  <span className="text-sm text-muted-foreground">Unavailable</span>
                )}
              </div>
            );
          })}
        </div>
      </div>

      <div className="rounded-lg border border-border bg-card p-6 shadow-card">
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

      <Button type="submit" disabled={submitting}>
        {submitting ? "Saving…" : "Save"}
      </Button>
    </form>
  );
}
