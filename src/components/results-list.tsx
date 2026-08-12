import { AvailabilityGrid } from "@/components/availability-grid";

export type Slot = { startUnix: number; endUnix: number; label: string };

export type AvailabilityResult = {
  slots: Slot[];
  checkedCount: number;
  totalSelected: number;
  notConnectedNames: string[];
  error?: string;
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
}: {
  result: AvailabilityResult;
  searchedParams: SearchedParams;
  onSelectSlot: (slot: Slot) => void;
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

      {result.slots.length === 0 ? (
        <p className="mt-4 text-sm text-foreground">
          No overlapping free time found in this range.
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
          </div>
          <AvailabilityGrid
            slots={result.slots}
            startDate={searchedParams.startDate}
            endDate={searchedParams.endDate}
            workingHoursStart={searchedParams.workingHoursStart}
            workingHoursEnd={searchedParams.workingHoursEnd}
            excludeWeekends={searchedParams.excludeWeekends}
            timezone={searchedParams.timezone}
            onSelectSlot={onSelectSlot}
          />
        </div>
      )}
    </div>
  );
}
