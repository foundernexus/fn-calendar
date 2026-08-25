"use client";

import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { OpenConflict } from "@/db/queries";

/** Dates in repeating sessions that somebody has since booked over.
 *
 * Sits at the top of the booking page rather than on a page of its own, and
 * renders nothing when there is nothing wrong. A list you have to go and look
 * at is a list nobody looks at; this is the page a Nexus Partner opens anyway,
 * and the whole point is that a clash four months out gets noticed while there
 * is still time to move it.
 *
 * Clicking one takes the search below straight to that week with that session's
 * people — no re-picking, no pressing Find a time. It deliberately does NOT
 * propose a replacement date: the grid shows what is free and the choice stays
 * with whoever is running the session. */
export function ConflictList({
  conflicts,
  onOpen,
}: {
  conflicts: OpenConflict[];
  onOpen: (conflict: OpenConflict) => void;
}) {
  if (conflicts.length === 0) return null;

  return (
    <div className="mb-6 rounded-lg border border-destructive/25 bg-destructive/5 p-5">
      <div className="flex items-start gap-2">
        <AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" />
        <div>
          <p className="text-sm font-semibold text-foreground">
            {conflicts.length === 1
              ? "A repeating session needs a new time"
              : `${conflicts.length} repeating sessions need a new time`}
          </p>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Someone&apos;s calendar changed after these were booked.
          </p>
        </div>
      </div>

      <ul className="mt-4 divide-y divide-destructive/15">
        {conflicts.map((c) => (
          <li key={c.id} className="flex flex-wrap items-center justify-between gap-3 py-2.5">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-foreground">{c.eventTitle}</p>
              <p className="text-xs text-muted-foreground">
                {/* In the SESSION's timezone, not the viewer's — the same rule
                    the advisor list follows, so a date here reads the same as
                    the one in the calendar invite. */}
                {new Intl.DateTimeFormat("en-US", {
                  weekday: "long",
                  day: "numeric",
                  month: "long",
                  hour: "numeric",
                  minute: "2-digit",
                  timeZone: c.timezone,
                }).format(c.occurrenceStartsAt)}{" "}
                · {c.conflictingNames}
              </p>
            </div>
            <Button type="button" variant="secondary" size="sm" onClick={() => onOpen(c)}>
              Find a new time
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}
