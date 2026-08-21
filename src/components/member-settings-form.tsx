"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { TimezoneSelect } from "@/components/timezone-select";
import { TimeSelect } from "@/components/time-select";
import { CalendarList } from "@/components/calendar-list";
import { isSupportedTimezone } from "@/lib/timezones";
import { celebrate } from "@/lib/celebrate";
import type { MemberCalendar } from "@/db/queries";

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
};
function providerLabel(provider: string) {
  return PROVIDER_LABELS[provider] ?? provider.charAt(0).toUpperCase() + provider.slice(1);
}

/** `neverSaved` is what a member's timezone being null tells us: they have
 * never submitted this form. It is NOT the same as "has no availability rows"
 * — a member who deliberately switched every day off also has no rows, and
 * must keep seeing every day off rather than having weekdays silently handed
 * back to them on the next visit.
 *
 * First-timers get Mon–Fri 09:00–17:00 switched on, the same starting point
 * Calendly and Cal.com use. The alternative — every day off — reads as a
 * neutral empty form but is really the most restrictive setting there is:
 * saving it (to pick a timezone, say) makes the member unbookable for
 * everyone, with no warning, and no slot will ever show for them again. */
function defaultDays(
  initial: { dayOfWeek: number; startTime: string; endTime: string }[],
  neverSaved: boolean
) {
  const byDay = new Map<number, Block[]>();
  for (const row of initial) {
    const list = byDay.get(row.dayOfWeek) ?? [];
    list.push({ startTime: row.startTime, endTime: row.endTime });
    byDay.set(row.dayOfWeek, list);
  }

  const days: Record<number, DayState> = {};
  for (let d = 0; d < 7; d++) {
    const existing = byDay.get(d);
    // 0 = Sunday, 6 = Saturday (see DISPLAY_ORDER) — so 1..5 is Mon–Fri.
    const weekdayDefault = neverSaved && d >= 1 && d <= 5;
    days[d] = existing?.length
      ? // Sorted because the rows come back in insertion order, and a member
        // who added an early-morning block second would otherwise see their
        // day listed out of order.
        { enabled: true, blocks: [...existing].sort((a, b) => a.startTime.localeCompare(b.startTime)) }
      : { enabled: weekdayDefault, blocks: [{ ...DEFAULT_BLOCK }] };
  }
  return days;
}

export function MemberSettingsForm({
  fullName,
  timezone: initialTimezone,
  initialAvailability,
  connection: initialConnection,
  calendars,
  checksEveryCalendar = false,
  needsReconnect,
}: {
  fullName: string;
  timezone: string | null;
  initialAvailability: { dayOfWeek: number; startTime: string; endTime: string }[];
  connection: { provider: string; grantEmail: string } | null;
  /** Every calendar this member holds. All are checked for conflicts; the one
   * flagged isInviteTarget receives sessions. */
  calendars: MemberCalendar[];
  /** Passed through to CalendarList — see the note on its prop. */
  checksEveryCalendar?: boolean;
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
  const [days, setDays] = useState<Record<number, DayState>>(() =>
    defaultDays(initialAvailability, initialTimezone === null)
  );
  const router = useRouter();
  const [connection, setConnection] = useState(initialConnection);
  const [submitting, setSubmitting] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  // A null timezone means this form has never been submitted — the same signal
  // defaultDays() uses above. Captured once at mount, because the save itself
  // is what makes it false, and reading it afterwards would always say no.
  const [firstSave, setFirstSave] = useState(initialTimezone === null);

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
        body: JSON.stringify({ timezone, availability }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? "Something went wrong. Please try again.");
        return;
      }
      // Saving with every day off is a valid choice, and also the most
      // consequential one on this page: it removes you from every search with
      // nothing on screen to say so. A plain "Saved." let people make
      // themselves invisible and wonder for weeks why nobody booked them.
      const madeThemselvesUnavailable = availability.length === 0;
      toast.success(
        madeThemselvesUnavailable
          ? "Saved — every day is off, so you won't be offered for any session until you turn one back on."
          : "Saved."
      );

      // Only on the FIRST real save, and only if they're actually bookable
      // afterwards. That is the one moment in this app worth marking: setup is
      // done and sessions can now be booked with them. Firing on every save
      // would make it wallpaper, and firing when they've just switched every
      // day off would be celebrating the opposite of what happened.
      if (firstSave && !madeThemselvesUnavailable) {
        setFirstSave(false);
        celebrate();
      }

      // The setup checklist is rendered on the SERVER from the member's saved
      // timezone, so without this it keeps insisting "Set your availability" is
      // outstanding immediately after you have set it — right up until a full
      // page reload. A checklist that denies what you just did is worse than no
      // checklist, because it teaches people to stop believing the ticks.
      //
      // Deliberately after the confetti: refresh() re-renders in the
      // background, and firing the celebration first keeps it tied to the click
      // rather than to a round trip.
      router.refresh();
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
      {/* Who you are and where you are on the left, the calendars you hold on
          the right, the week itself full width below. Stacking all three made
          the page taller than the viewport again — the thing that pushed Save
          off-screen once already — and the first two are short enough to sit
          side by side. Stacks again below lg, where two columns would squeeze
          the calendar addresses. */}
      {/* No items-start: the cards stretch to a shared height. Left to size
          themselves they end up visibly uneven, which reads as broken rather
          than deliberate. */}
      <div className="grid gap-5 lg:grid-cols-2">
      <div className="rounded-lg border border-border bg-card p-6 shadow-card">
        {/* Stacked, not two columns inside a column: the timezone select was
            cramped beside the name, and the taller card sits closer to the
            calendars beside it. */}
        <div className="space-y-6">
          <div>
            <p className="text-base font-semibold text-foreground">{fullName}</p>
            {connection ? (
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                <Badge className="bg-accent text-accent-foreground">Connected</Badge>
                <span className="text-xs text-muted-foreground">
                  {providerLabel(connection.provider)}
                </span>
              </div>
            ) : needsReconnect ? (
              <Badge className="mt-2 bg-secondary text-secondary-foreground">Needs reconnect</Badge>
            ) : (
              <p className="mt-2 text-xs text-destructive">Not connected.</p>
            )}
            {connection && (
              <p className="mt-1 truncate text-xs text-muted-foreground">
                sessions go to {connection.grantEmail}
              </p>
            )}
            {/* Connecting and removing individual calendars live in the
                Calendars card below, which can show all of them. What's left
                here is the two whole-account actions: repair a broken
                connection, or stop being scheduled at all. */}
            <div className="mt-3 flex gap-2">
              {!connection && (
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={handleReconnect}
                  disabled={reconnecting}
                >
                  {needsReconnect ? "Reconnect" : "Connect calendar"}
                </Button>
              )}
              {(connection || needsReconnect) && (
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={handleDisconnect}
                  disabled={submitting}
                >
                  Disconnect all
                </Button>
              )}
            </div>
          </div>

          <div>
            <Label htmlFor="timezone">Your timezone</Label>
            <div className="mt-2">
              <TimezoneSelect id="timezone" value={timezone} onChange={setTimezone} />
            </div>
          </div>

        </div>
      </div>

        <CalendarList calendars={calendars} checksEveryCalendar={checksEveryCalendar} />
      </div>

      <div
        data-tour="availability"
        className="mt-5 rounded-lg border border-border bg-card p-6 shadow-card"
      >
        <p className="text-base font-semibold text-foreground">Weekly availability</p>
        <p className="mt-1 text-sm text-muted-foreground">
          The hours you&apos;re open to sessions. Your calendar is still checked on top of this —
          these are the outer bounds, not a promise you&apos;re free.
        </p>
        {/* Shown before saving, not only after. Every day off is the one
            setting here that makes someone disappear from every search, and it
            looks identical to a form nobody has filled in yet. */}
        {DISPLAY_ORDER.every((d) => !days[d].enabled) && (
          <p className="mt-3 rounded-lg border border-destructive/20 bg-destructive/10 p-3 text-sm text-destructive">
            Every day is switched off. Save this and you won&apos;t be offered for any session at
            all — turn a day on if that isn&apos;t what you meant.
          </p>
        )}
        <div className="mt-4 divide-y divide-border">
            {DISPLAY_ORDER.map((day) => {
              const d = days[day];
              return (
                <div
                  key={day}
                  className="grid grid-cols-[auto_3.5rem_1fr] items-start gap-4 py-3 first:pt-0 last:pb-0"
                >
                  <Switch
                    className="mt-1"
                    checked={d.enabled}
                    onCheckedChange={(checked) => updateDay(day, { enabled: checked })}
                  />
                  <span
                    className={`mt-1.5 text-sm font-medium ${
                      d.enabled ? "text-foreground" : "text-muted-foreground"
                    }`}
                  >
                    {DAY_LABELS[day]}
                  </span>
                  {d.enabled ? (
                    <div className="flex flex-col items-start gap-2">
                      {d.blocks.map((block, index) => {
                        const isLast = index === d.blocks.length - 1;
                        return (
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
                          {/* Inline on the last row rather than on a line of
                              its own below. A one-block day is then a single
                              row, which roughly halves the height of the card
                              — the reason Save was falling off-screen. */}
                          {isLast && d.blocks.length < MAX_BLOCKS_PER_DAY && (
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              className="text-muted-foreground"
                              onClick={() => addBlock(day)}
                            >
                              + Add block
                            </Button>
                          )}
                        </div>
                        );
                      })}
                    </div>
                  ) : (
                    <span className="mt-1.5 block text-sm text-muted-foreground">Unavailable</span>
                  )}
                </div>
              );
            })}
        </div>
      </div>

      {/* Sticky: three blocks on several days can still outgrow a short
          window, and a Save you have to hunt for is a Save people forget to
          press. */}
      <div
        data-tour="save"
        className="sticky bottom-0 z-10 mt-5 flex justify-end rounded-lg border border-border bg-card/95 px-5 py-3 shadow-card backdrop-blur"
      >
        <Button type="submit" disabled={submitting}>
          {submitting ? "Saving…" : "Save"}
        </Button>
      </div>
    </form>
  );
}
