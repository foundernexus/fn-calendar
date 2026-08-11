import { AvailabilityGrid } from "@/components/availability-grid";

export type Slot = { startUnix: number; endUnix: number; label: string };

export type AvailabilityResult = {
  slots: Slot[];
  checkedCount: number;
  totalSelected: number;
  notConnectedNames: string[];
  error?: string;
};

/** The search parameters the grid needs to lay itself out — snapshotted by
 * the caller at search time, not read live, so the grid never renders
 * against a range/timezone that's since changed in the form above it. */
export type SearchedParams = {
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
        Checked {result.checkedCount} of {result.totalSelected} selected member
        {result.totalSelected === 1 ? "" : "s"}.
        {result.notConnectedNames.length > 0 && (
          <>
            {" "}
            {result.notConnectedNames.join(", ")}{" "}
            {result.notConnectedNames.length === 1 ? "hasn't" : "haven't"} connected yet.
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
