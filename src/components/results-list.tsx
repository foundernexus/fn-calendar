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
  /** Carried so rescheduling can repopulate the search with this session's own
   * people rather than whatever happens to be selected in the form. */
  organizerMemberId: number;
  attendees: BookedAttendee[];
};

export type AvailabilityResult = {
  slots: Slot[];
  checkedCount: number;
  totalSelected: number;
  notConnectedNames: string[];
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

      {result.slots.length === 0 && (result.bookedSlots?.length ?? 0) === 0 ? (
        <p className="mt-4 text-sm text-foreground">
          {result.filteredByPreferences
            ? "Everyone's calendar overlaps at some point in this range, but it all falls outside someone's stated availability, or the advisor is already at their weekly session limit. Try adjusting the working hours, a different date range, or ask them to update their preferences on /me."
            : "No overlapping free time found in this range."}
        </p>
      ) : (
        <div className="mt-4">
          <div className="mb-3 flex items-center gap-4 text-xs text-muted-foreground">
            <span className="flex items-center gap-1.5">
              <span className="inline-block size-3 rounded-xs bg-accent" /> Everyone free
            </span>
            <span className="flex items-center gap-1.5">
              <span className="inline-block size-3 rounded-xs bg-secondary" /> Not available
            </span>
            <span className="flex items-center gap-1.5">
              <span className="inline-block size-3 rounded-xs border border-foreground/30 bg-white" /> Already
              booked
            </span>
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
            onSelectSlot={onSelectSlot}
            onSelectBooked={onSelectBooked}
          />
        </div>
      )}
    </div>
  );
}
