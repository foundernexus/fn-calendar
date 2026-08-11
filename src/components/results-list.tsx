import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";

export type Slot = { startUnix: number; endUnix: number; label: string };

export type AvailabilityResult = {
  slots: Slot[];
  checkedCount: number;
  totalSelected: number;
  notConnectedNames: string[];
  error?: string;
};

export function ResultsList({
  result,
  onSelectSlot,
}: {
  result: AvailabilityResult;
  onSelectSlot: (slot: Slot) => void;
}) {
  if (result.error) {
    return (
      <div className="rounded-lg border border-destructive/20 bg-destructive/10 p-6 text-sm text-destructive">
        <p>{result.error}</p>
        {result.notConnectedNames.length > 0 && (
          <p className="mt-2">
            Not connected: {result.notConnectedNames.join(", ")}.
          </p>
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
        <Table className="mt-4">
          <TableHeader>
            <TableRow>
              <TableHead>Time</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {result.slots.map((slot) => (
              <TableRow key={slot.startUnix}>
                <TableCell>
                  {slot.label} — all {result.checkedCount} free
                </TableCell>
                <TableCell className="text-right">
                  <Button size="sm" onClick={() => onSelectSlot(slot)}>
                    Create event
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
