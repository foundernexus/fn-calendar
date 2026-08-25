"use client";

import { useEffect, useRef, useState } from "react";
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
  type BookedSlot,
  type Slot,
  type SearchedParams,
} from "@/components/results-list";
import { CreateEventDialog } from "@/components/create-event-dialog";
import { CancelSessionDialog } from "@/components/cancel-session-dialog";
import { RescheduleSessionDialog } from "@/components/reschedule-session-dialog";
import { ConflictList } from "@/components/conflict-list";
import type { MemberWithConnection, OpenConflict } from "@/db/queries";
import { TIMEZONES, spellOutDate, addDaysToDateString } from "@/lib/time";
import { TimeSelect } from "@/components/time-select";
import { handleExpiredSession } from "@/lib/session-expired";

// 15 is here because a Nexus Partner's monthly member check-in is a quarter
// hour, and it was the length they asked for twice. Slots are still offered on
// the grid's 30-minute rows — a 15-minute call simply ends halfway down one.
const DURATIONS = [15, 30, 45, 60] as const;

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
  members,
  signedInEmail,
  conflicts = [],
}: {
  members: MemberWithConnection[];
  /** Dates in repeating sessions that stopped working since they were booked.
   * Found by the daily check; shown here because this is the page a Nexus
   * Partner already opens. */
  conflicts?: OpenConflict[];
  /** Whoever is looking at this page. Only used to preselect them as the
   * session lead — every other decision on this form is theirs to make. */
  signedInEmail?: string;
}) {
  const connectedMembers = members.filter((m) => m.connected);
  // Session lead is a curated subset — connecting a calendar makes someone
  // eligible as a guest, not automatically eligible to lead a session.
  const facilitators = connectedMembers.filter((m) => m.isFacilitator);
  // Same idea as facilitators: a curated subset, not everyone connected.
  const advisors = connectedMembers.filter((m) => m.isAdvisor);
  // Advisors are deliberately absent from the guest list entirely, not just
  // hidden once picked above: being an advisor is a distinct role on the
  // session (own dashboard, own session cap, its own attendee role), so
  // booking one as an ordinary guest is never what's intended. Marking
  // someone as an advisor is what moves them from one field to the other.
  // Founders, by the same definition the People page uses (roleOf in
  // member-directory: advisor wins, then team, then founder). This used to
  // exclude advisors only, so anyone marked Team appeared in BOTH the session
  // lead picker and the founder list — FounderNexus staff listed as founders of
  // the companies they run sessions for. Two rules for the word "founder" in
  // one app, and the People page had the right one.
  const guestCandidates = connectedMembers.filter((m) => !m.isAdvisor && !m.isFacilitator);

  // The person scheduling the session is usually the one leading it, so they
  // start selected. This used to be facilitators[0], which is whoever sorts
  // first by name — a stable answer, but an arbitrary one, and it meant
  // everybody had to change the field every time or quietly book someone else
  // as lead.
  //
  // Falls back to the old behaviour for an admin who can't lead sessions
  // themselves, so the field is never left empty when there is something valid
  // to put in it.
  const defaultOrganizer =
    (signedInEmail
      ? facilitators.find((m) => m.email.toLowerCase() === signedInEmail.toLowerCase())
      : undefined) ?? facilitators[0];

  const [organizerMemberIdState, setOrganizerMemberId] = useState<number | null>(
    defaultOrganizer?.id ?? null
  );
  // Optional — most sessions won't have one.
  const [advisorMemberIdState, setAdvisorMemberId] = useState<number | null>(null);
  const [guestMemberIdsState, setGuestMemberIds] = useState<number[]>([]);
  const [startDateState, setStartDate] = useState(defaultDateString(0));
  const [endDateState, setEndDate] = useState(defaultDateString(14));
  const [durationMinutesState, setDurationMinutes] = useState(60);
  const [workingHoursStart, setWorkingHoursStart] = useState("09:00");
  const [workingHoursEnd, setWorkingHoursEnd] = useState("17:00");
  const [timezone, setTimezone] = useState<string>(TIMEZONES[0].value);
  const [excludeWeekends, setExcludeWeekends] = useState(true);
  // Off by default. It narrows what is on offer, and a search that silently
  // returns fewer times than it could is the wrong thing to hand someone
  // before they have asked for it.
  const [requireLead, setRequireLead] = useState(false);

  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<AvailabilityResult | null>(null);
  const [dialogSlot, setDialogSlot] = useState<Slot | null>(null);
  const [cancelTarget, setCancelTarget] = useState<BookedSlot | null>(null);
  // The session being moved, if any. While this is set, picking a slot moves
  // that session instead of creating a new one — the form itself is unchanged,
  // which is the point: finding a new time is the same search, so it would be
  // wasteful (and a second thing to keep working) to build a separate screen
  // for it.
  const [reschedulingSession, setReschedulingSession] = useState<BookedSlot | null>(null);
  const formRef = useRef<HTMLFormElement>(null);
  // Held so it can be cleared on unmount — a refetch landing after this
  // component is gone would set state on nothing.
  const delayedRefreshRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const resultsRef = useRef<HTMLDivElement>(null);
  // Set by a fresh search only, never by the post-booking refetch — yanking
  // the page down while someone is reading a confirmation would be worse than
  // the problem this solves.
  const [scrollToResults, setScrollToResults] = useState(false);
  // The exact request body of the last search, replayed after a booking to
  // refresh the grid. Kept separately from `searchedParams` (which exists for
  // rendering) because the refetch has to send precisely what was searched —
  // including durationMinutesState, which the render snapshot doesn't carry.
  const [lastSearchBody, setLastSearchBody] = useState<Record<string, unknown> | null>(null);
  // Snapshotted at search time, NOT read live from the form above — every
  // field here can change after a search completes while the grid is still
  // showing the old search's results. Without this, the grid could render
  // against a range/timezone/lead/guest-list it was never actually searched
  // for, and the dialog could create an event for a group that was never
  // checked.
  const [searchedParams, setSearchedParams] = useState<SearchedParams | null>(null);

  /** Runs the search.
   *
   * `over` exists so a conflict can be opened in one click. React state is set
   * asynchronously, so setting the fields and then calling this would search
   * with the PREVIOUS values — the overrides are passed straight through
   * instead, and the fields are updated alongside purely so the form shows what
   * was searched. */
  /** Takes the search straight to the week a clash falls in, with that
   * session's own people.
   *
   * Sets the fields so the form shows what is being searched, and passes the
   * same values to the search directly — React state is set asynchronously, so
   * relying on the fields would search with whatever was there before.
   *
   * Deliberately no suggested replacement: the grid shows what is free and the
   * choice belongs to whoever runs the session. */
  function openConflict(conflict: OpenConflict) {
    const day = new Intl.DateTimeFormat("en-CA", { timeZone: conflict.timezone }).format(
      conflict.occurrenceStartsAt
    );
    // The whole week around it, so there is somewhere else to move to — a
    // single day would often show nothing and be a dead end.
    const from = addDaysToDateString(day, -3);
    const to = addDaysToDateString(day, 3);
    const guests = conflict.memberIds.filter((id) => id !== conflict.organizerMemberId);

    setOrganizerMemberId(conflict.organizerMemberId);
    setGuestMemberIds(guests);
    setStartDate(from);
    setEndDate(to);
    setDurationMinutes(conflict.durationMinutes);
    void handleSearch(null, {
      organizerMemberId: conflict.organizerMemberId,
      guestMemberIds: guests,
      startDate: from,
      endDate: to,
      durationMinutes: conflict.durationMinutes,
    });
  }

  async function handleSearch(
    e: React.FormEvent | null,
    over: Partial<{
      organizerMemberId: number;
      guestMemberIds: number[];
      advisorMemberId: number | null;
      startDate: string;
      endDate: string;
      durationMinutes: number;
    }> = {}
  ) {
    e?.preventDefault();
    const organizerMemberId = over.organizerMemberId ?? organizerMemberIdState;
    const guestMemberIds = over.guestMemberIds ?? guestMemberIdsState;
    const advisorMemberId =
      over.advisorMemberId === undefined ? advisorMemberIdState : over.advisorMemberId;
    const startDate = over.startDate ?? startDateState;
    const endDate = over.endDate ?? endDateState;
    const durationMinutes = over.durationMinutes ?? durationMinutesState;

    if (!organizerMemberId) {
      toast.error("Pick who's leading this session.");
      return;
    }
    if (guestMemberIds.length === 0) {
      toast.error("Add at least one founder.");
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
      leadMinutes: requireLead ? 15 : 0,
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
      if (handleExpiredSession(res)) return;
      if (!res.ok) {
        toast.error(data.error ?? "Something went wrong. Please try again.");
        return;
      }
      setResult(data);
      setScrollToResults(true);
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

  // The grid renders below a tall form, so on most screens a completed search
  // leaves it off-screen — and someone using this for the first time has no
  // reason to suspect there's anything down there. Runs in an effect rather
  // than straight after setResult because the grid doesn't exist in the DOM
  // until React has rendered the new state.
  useEffect(() => {
    if (!scrollToResults || !result) return;
    setScrollToResults(false);
    resultsRef.current?.scrollIntoView({
      // Honour the OS "reduce motion" setting — a long smooth scroll is
      // exactly the kind of movement people turn that on to avoid.
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
        ? "auto"
        : "smooth",
      block: "start",
    });
  }, [scrollToResults, result]);

  useEffect(
    () => () => {
      if (delayedRefreshRef.current) clearTimeout(delayedRefreshRef.current);
    },
    []
  );

  /** Replays the last search after a booking, cancellation or move, so the
   * grid reflects it straight away instead of the admin having to reload.
   *
   * Deliberately replays `lastSearchBody` rather than the live form fields —
   * those can have been edited since the search, and re-running with them
   * would swap the grid out for a different range or founder list than the one
   * the admin is currently looking at. Same reasoning as the searchedParams
   * snapshot above.
   *
   * Doesn't clear `result` first, so the grid stays on screen while this runs
   * and the row just changed doesn't flash away and back. */
  async function refreshResults() {
    if (!lastSearchBody) return;
    try {
      const res = await fetch("/api/admin/availability", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(lastSearchBody),
      });
      const data = await res.json();
      if (!res.ok) {
        // Deliberately NOT handleExpiredSession, even on a 401. Whatever the
        // admin just did already succeeded, and redirecting them to sign-in
        // here would throw away the confirmation of a booking or cancellation
        // that really happened — leaving them unsure whether to do it again.
        // Telling them and letting them reload is the safer end of that trade;
        // the reload sends them to sign-in anyway.
        toast.error("That worked, but the grid couldn't refresh. Reload to see the latest.");
        return;
      }
      setResult(data);
    } catch {
      toast.error("That worked, but the grid couldn't refresh. Reload to see the latest.");
    }
  }

  /** Cancelling and moving both free up a slot, and the slot going blue again
   * comes from Nylas reading the real calendar — NOT from our own row, which
   * is already updated by the time the first refresh runs. The provider needs
   * a moment to stop reporting those people as busy, so an immediate refetch
   * reliably shows the cell as unavailable rather than free, and it silently
   * corrects itself later.
   *
   * So: refresh now for the parts we own (the session stops showing as
   * booked), then once more shortly after for the part the provider owns. */
  function refreshResultsAfterFreeingSlot() {
    void refreshResults();
    if (delayedRefreshRef.current) clearTimeout(delayedRefreshRef.current);
    delayedRefreshRef.current = setTimeout(() => {
      delayedRefreshRef.current = null;
      void refreshResults();
    }, 6000);
  }

  /** Switches the page into "find a new time for this session" mode: loads the
   * session's own people into the form, drops the results so nothing stale is
   * clickable underneath, and puts the form back on screen. The old session
   * stays booked and untouched until a new slot is actually confirmed —
   * backing out costs nothing. */
  function startRescheduling(booked: BookedSlot) {
    setCancelTarget(null);
    setReschedulingSession(booked);
    setOrganizerMemberId(booked.organizerMemberId);
    setAdvisorMemberId(booked.attendees.find((a) => a.role === "advisor")?.memberId ?? null);
    setGuestMemberIds(
      booked.attendees
        .filter((a) => a.role === "guest" && a.memberId !== booked.organizerMemberId)
        .map((a) => a.memberId)
    );
    setDurationMinutes(Math.round((booked.endUnix - booked.startUnix) / 60));
    setResult(null);
    setSearchedParams(null);
    formRef.current?.scrollIntoView({
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
      block: "start",
    });
  }

  return (
    <div className="space-y-8">
      {/* Above everything, and invisible when there is nothing wrong. */}
      {!reschedulingSession && <ConflictList conflicts={conflicts} onOpen={openConflict} />}

      {reschedulingSession ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-secondary/50 p-4">
          <p className="text-sm text-foreground">
            Finding a new time for{" "}
            <span className="font-medium">{reschedulingSession.title}</span>.{" "}
            <span className="text-muted-foreground">
              Its people are loaded below — pick a slot to move it. Nothing changes until you
              confirm.
            </span>
          </p>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => setReschedulingSession(null)}
          >
            Stop rescheduling
          </Button>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          {connectedMembers.length} calendar{connectedMembers.length === 1 ? "" : "s"} connected
        </p>
      )}
      <form
        ref={formRef}
        onSubmit={handleSearch}
        className="scroll-mt-4 space-y-6 rounded-lg border border-border bg-card p-6 shadow-card"
      >
        <div className="space-y-2">
          <Label htmlFor="session-lead">Session lead</Label>
          <MemberSelect
            id="session-lead"
            members={facilitators}
            value={organizerMemberIdState}
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
            value={advisorMemberIdState}
            // No need to clear this person out of the guest selection the way
            // the session lead does: advisors are filtered out of the guest
            // list entirely (see guestCandidates), so they can never have been
            // selected as a guest in the first place.
            onChange={setAdvisorMemberId}
            placeholder="Add an advisor to this session?"
            emptyText="No connected advisors — mark someone as an advisor when adding them."
          />
          <p className="text-xs text-muted-foreground">
            Their calendar is checked like everyone else&apos;s, and they&apos;ll see the session on
            their advisor dashboard. Pick the same person again to clear this.
          </p>
        </div>

        <div className="space-y-2">
          {/* Adding people lives on /admin/members now, not here: this page is
              for booking, that one is for who exists and what they've
              connected. Nothing is lost by the move — someone added here could
              never be booked in the same sitting anyway, since they don't
              appear in any picker until they've connected a calendar. */}
          {/* "Founders", matching the People page's grouping and the language
              everyone here actually uses. Slightly loose: this list is
              "connected and not an advisor", so a Team member could appear in
              it if they're attending rather than leading. That's rare enough
              to be worth the plainer word. */}
          <Label htmlFor="guests">Founders</Label>
          <MemberMultiSelect
            id="guests"
            members={guestCandidates}
            value={guestMemberIdsState}
            onChange={setGuestMemberIds}
            excludeId={organizerMemberIdState}
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
          ) : guestCandidates.length === 0 ? (
            // Everyone connected is an advisor. Without this the picker would
            // just be empty with the reassuring "only connected people can be
            // selected" note below it, which reads like a bug.
            <p className="text-sm text-destructive">
              Everyone who&apos;s connected is marked as an advisor — pick them in the advisor field
              above, or add a founder on the{" "}
              <Link href="/admin/members" className="underline">
                People page
              </Link>
              .
            </p>
          ) : (
            <p className="text-xs text-muted-foreground">
              Only people who&apos;ve connected their calendar can be selected — that&apos;s what
              makes the grid below meaningful.
            </p>
          )}
        </div>

        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
          {/* The native date picker stays — it is genuinely the best control for
              choosing a date, and it is keyboard and screen-reader friendly.
              What it will NOT do is render in a locale of our choosing: it
              follows the browser's, so the same field reads 01.09.2026 on a
              German machine and 9/1/2026 on a US one, and no attribute changes
              that.
              So the resolved date is spelled out underneath in US form, with
              the weekday and the month by name. "Tue, Sep 1, 2026" cannot be
              read as the ninth of January whatever your browser is set to. */}
          <div className="space-y-2">
            <Label htmlFor="start-date">Start date</Label>
            <Input
              id="start-date"
              type="date"
              value={startDateState}
              onChange={(e) => setStartDate(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">{spellOutDate(startDateState)}</p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="end-date">End date</Label>
            <Input
              id="end-date"
              type="date"
              value={endDateState}
              onChange={(e) => setEndDate(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">{spellOutDate(endDateState)}</p>
          </div>
          <div className="space-y-2">
            <Label>Duration</Label>
            <Select
              items={Object.fromEntries(DURATIONS.map((d) => [String(d), `${d} min`]))}
              value={String(durationMinutesState)}
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
          {/* TimeSelect, not <input type="time">. A native time input renders in
              the BROWSER's locale — 24-hour "17:00" on a German machine, 12-hour
              "5:00 PM" on a US one — and that cannot be forced from the page.
              TimeSelect renders every label itself, so it reads the same for
              everyone, and it is what the availability form already uses. The
              two screens disagreeing on how to write five o'clock was its own
              small bug. */}
          <div className="space-y-2">
            <Label htmlFor="hours-start">Working hours start</Label>
            <TimeSelect
              id="hours-start"
              value={workingHoursStart}
              onChange={setWorkingHoursStart}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="hours-end">Working hours end</Label>
            <TimeSelect id="hours-end" value={workingHoursEnd} onChange={setWorkingHoursEnd} />
          </div>
        </div>

        <label className="flex items-center gap-2 text-sm text-foreground">
          <Checkbox
            checked={excludeWeekends}
            onCheckedChange={(checked) => setExcludeWeekends(!!checked)}
          />
          Exclude weekends
        </label>

        {/* People arrive late because their previous call ran up to the minute
            this one starts. With this on, a time is only offered when everybody
            has a quarter of an hour clear beforehand. */}
        <label className="flex items-start gap-2 text-sm text-foreground">
          <Checkbox
            className="mt-0.5"
            checked={requireLead}
            onCheckedChange={(checked) => setRequireLead(!!checked)}
          />
          <span>
            Leave 15 minutes before the session
            <span className="block text-xs text-muted-foreground">
              Only offers times where nobody is coming straight out of another meeting.
            </span>
          </span>
        </label>

        <Button type="submit" disabled={loading}>
          {loading ? "Searching…" : "Find a time"}
        </Button>
      </form>

      {result && searchedParams && (
        <div ref={resultsRef} className="scroll-mt-4">
        <ResultsList
          result={result}
          searchedParams={searchedParams}
          onSelectSlot={setDialogSlot}
          onSelectBooked={setCancelTarget}
        />
        </div>
      )}

      {/* Not while rescheduling — the same slot click means "move that session
          there", handled by RescheduleSessionDialog below. */}
      {dialogSlot && searchedParams && !reschedulingSession && (
        <CreateEventDialog
          slot={dialogSlot}
          organizerMemberId={searchedParams.organizerMemberId}
          organizerName={searchedParams.organizerName}
          // The lead's standing meeting room, if they keep one. A personal room
          // is a single room, so it doesn't vary by session length — this is
          // only a starting value and can be replaced for a one-off.
          defaultMeetingUrl={
            members.find((m) => m.id === searchedParams.organizerMemberId)?.meetingLinks
              ?.default ?? ""
          }
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
            void refreshResults();
          }}
        />
      )}

      {cancelTarget && searchedParams && (
        <CancelSessionDialog
          booked={cancelTarget}
          timezone={searchedParams.timezone}
          onOpenChange={(open) => {
            if (!open) setCancelTarget(null);
          }}
          onCancelled={() => {
            setCancelTarget(null);
            // The cancelled session must stop showing as a blocked cell (ours,
            // instant) and its slot has to go free again (the provider's, delayed).
            void refreshResultsAfterFreeingSlot();
          }}
          onReschedule={() => startRescheduling(cancelTarget)}
        />
      )}

      {reschedulingSession && dialogSlot && searchedParams && (
        <RescheduleSessionDialog
          booked={reschedulingSession}
          slot={dialogSlot}
          timezone={searchedParams.timezone}
          onOpenChange={(open) => {
            if (!open) setDialogSlot(null);
          }}
          onRescheduled={() => {
            setDialogSlot(null);
            setReschedulingSession(null);
            void refreshResultsAfterFreeingSlot();
          }}
        />
      )}
    </div>
  );
}
