import { AvailabilityGrid } from "@/components/availability-grid";

export type Slot = { startUnix: number; endUnix: number; label: string };
export type BookedAttendee = {
  memberId: number;
  fullName: string;
  email: string;
  role: string;
};
export type BookedSlot = {
  id: number;
  startUnix: number;
  endUnix: number;
  title: string;
  /** The repeat rule, when this session is one of a series. Null for the
   * ordinary one-off. Its presence is what makes the dialogs offer a choice
   * between this date and the whole series. */
  recurrenceRule?: string | null;
  /** Which date of the series this is, as the rule puts it. Sent back to move
   * or drop this one date. Differs from `startUnix` once it has been moved —
   * the original start is the stable handle, here and at the provider. */
  occurrenceStartUnix?: number;
  /** Carried so rescheduling can repopulate the search with this session's own
   * people rather than whatever happens to be selected in the form. */
  organizerMemberId: number;
  attendees: BookedAttendee[];
};

/** One entry from the viewer's OWN calendar. Never anyone else's — the grid
 * shows these so a gap can be read as "I'm with Court then" rather than just
 * grey. */
export type OwnEventSummary = {
  startUnix: number;
  endUnix: number;
  title: string;
  allDay: boolean;
};

export type AvailabilityResult = {
  slots: Slot[];
  checkedCount: number;
  totalSelected: number;
  notConnectedNames: string[];
  /** Connected, but their calendar couldn't be read — a withheld permission, a
   * revoked token. Distinct from not connected, and more dangerous: these
   * people were skipped, so the slots below don't account for them. Optional so
   * a response from an older deploy still renders. */
  unreadableNames?: string[];
  /** The viewer's own calendar for the searched range. Optional so a response
   * from an older deploy still renders. */
  ownEvents?: OwnEventSummary[];
  /** How many times the run-up filter cost. Shown so a thin result reads as
   * "you asked for a gap", not "nobody is free". */
  droppedByLead?: number;
  /** The one person whose absence would unlock times, when nothing fits. Null
   * when no single person is the problem. */
  constraint?: { label: string; slotsWithout: number } | null;
  error?: string;
  /** True when Nylas found real calendar overlap but it all got filtered out
   * by someone's stated /me availability window or a guest's weekly session
   * cap — see api/admin/availability for how this differs from Nylas finding
   * nothing at all. */
  filteredByPreferences?: boolean;
  /** Real sessions already booked through this tool, overlapping the search
   * and involving anyone selected — rendered on the grid as a distinct cell
   * instead of an unexplained gray "not available" one. */
  bookedSlots?: BookedSlot[];
};

/** The search parameters the grid needs — snapshotted by the caller at
 * search time, not read live, so it never renders against a range/timezone/
 * lead/guest-list that's since changed in the form above it. Guests are part
 * of this snapshot (unlike the session lead's other settings, they directly
 * determine what the collective availability check covers) — changing the
 * guest picker after a search leaves the old results showing until the next
 * search, matching how every other field here behaves. */
export type SearchedParams = {
  organizerMemberId: number;
  organizerName: string;
  /** Null when the session has no advisor, which is the common case. */
  advisorMemberId?: number | null;
  advisorName?: string | null;
  guestMemberIds: number[];
  startDate: string;
  endDate: string;
  workingHoursStart: string;
  workingHoursEnd: string;
  excludeWeekends: boolean;
  timezone: string;
};

export function ResultsList({
  result,
  searchedParams,
  onSelectSlot,
  onSelectBooked,
}: {
  result: AvailabilityResult;
  searchedParams: SearchedParams;
  onSelectSlot: (slot: Slot) => void;
  onSelectBooked: (booked: BookedSlot) => void;
}) {
  if (result.error) {
    return (
      <div className="rounded-lg border border-destructive/20 bg-destructive/10 p-6 text-sm text-destructive">
        <p>{result.error}</p>
        {result.notConnectedNames.length > 0 && (
          <p className="mt-2">Not connected: {result.notConnectedNames.join(", ")}.</p>
        )}
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-border bg-card p-6 shadow-card">
      <p className="text-sm text-muted-foreground">
        Checked {result.checkedCount} of {result.totalSelected} selected
        {result.totalSelected === 1 ? "" : " people"}.
        {result.notConnectedNames.length > 0 && (
          <>
            {" "}
            {result.notConnectedNames.join(", ")}{" "}
            {result.notConnectedNames.length === 1 ? "wasn't" : "weren't"} connected — excluded from
            the check but will still be invited.
          </>
        )}
      </p>

      {/* Deliberately loud, and deliberately not folded into the muted line
          above. Someone here is connected — so nothing on screen would
          otherwise suggest a problem — but their calendar was skipped, which
          means every slot below is offered without knowing whether they're
          free. That is the one thing an admin must not learn afterwards. */}
      {(result.unreadableNames?.length ?? 0) > 0 && (
        <p className="mt-3 rounded-md border border-destructive/20 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {result.unreadableNames!.length === 1
            ? "This calendar couldn't be read, so the times below don't account for it: "
            : "These calendars couldn't be read, so the times below don't account for them: "}
          <span className="font-medium">{result.unreadableNames!.join(", ")}</span>. Ask{" "}
          {result.unreadableNames!.length === 1 ? "them" : "each of them"} to reconnect from their
          settings page.
        </p>
      )}

      {/* A run-up that removed times says so. Otherwise a search that quietly
          returns three slots instead of eleven reads as "these people are
          impossible to schedule" when it really means "you asked for a gap
          before the session". */}
      {(result.droppedByLead ?? 0) > 0 && (
        <p className="mt-3 text-sm text-muted-foreground">
          {result.droppedByLead} more{" "}
          {result.droppedByLead === 1 ? "time is" : "times are"} available without a run-up —
          untick it above to see {result.droppedByLead === 1 ? "it" : "them"}.
        </p>
      )}

      {result.slots.length === 0 && (result.bookedSlots?.length ?? 0) === 0 ? (
        <div className="mt-4 space-y-2 text-sm text-foreground">
          <p>
            {result.filteredByPreferences
              ? "Everyone's calendar overlaps at some point in this range, but it all falls outside someone's stated availability."
              : "No overlapping free time found in this range."}
          </p>
          {/* "No overlapping free time" is true and useless: it doesn't say
              whether five people are wide open and one is impossible, which is
              the difference between widening the range and dropping somebody.
              This says which. */}
          {result.constraint ? (
            <p className="rounded-md border border-border bg-secondary/40 px-3 py-2">
              <span className="font-medium">{result.constraint.label}</span> is the constraint —
              without {result.constraint.label.split(" ")[0]} there{" "}
              {result.constraint.slotsWithout === 1 ? "is" : "are"}{" "}
              <span className="font-medium">{result.constraint.slotsWithout}</span>{" "}
              {result.constraint.slotsWithout === 1 ? "time" : "times"} in this range.
            </p>
          ) : (
            <p className="text-muted-foreground">
              No single person unlocks this — try a wider date range or different working hours.
            </p>
          )}
        </div>
      ) : (
        <div className="mt-4">
          {/* The first person outside the team to open this grid read it
              backwards — she took the coloured cells for blocked time and the
              plain ones for free. Reasonably: a coloured block on a calendar
              normally means something is IN it. The legend existed but said
              only "Everyone free" and "Not available", which doesn't tell you
              which square is which until you've already guessed. */}
          <div className="mb-3 flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-muted-foreground">
            <span className="flex items-center gap-1.5">
              <span className="inline-block size-3 shrink-0 rounded-xs border border-border bg-accent" />
              Everyone free — click to book
            </span>
            <span className="flex items-center gap-1.5">
              <span className="inline-block size-3 shrink-0 rounded-xs border border-border bg-secondary" />
              Someone&apos;s busy
            </span>
            <span className="flex items-center gap-1.5">
              <span className="inline-block size-3 shrink-0 rounded-xs border border-border bg-card ring-1 ring-inset ring-foreground/15" />
              Already booked here
            </span>
            {(result.ownEvents?.length ?? 0) > 0 && (
              <span>Grey cells show what&apos;s in your own calendar.</span>
            )}
          </div>
          <AvailabilityGrid
            slots={result.slots}
            bookedSlots={result.bookedSlots ?? []}
            startDate={searchedParams.startDate}
            endDate={searchedParams.endDate}
            workingHoursStart={searchedParams.workingHoursStart}
            workingHoursEnd={searchedParams.workingHoursEnd}
            excludeWeekends={searchedParams.excludeWeekends}
            timezone={searchedParams.timezone}
            ownEvents={result.ownEvents ?? []}
            onSelectSlot={onSelectSlot}
            onSelectBooked={onSelectBooked}
          />
        </div>
      )}
    </div>
  );
}
