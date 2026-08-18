"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  addDaysToDateString,
  formatDateLabel,
  formatTimeLabel,
  generateTimeRows,
  isWeekendDateString,
  zonedDateTimeParts,
  AVAILABILITY_INTERVAL_MINUTES,
} from "@/lib/time";
import type { Slot, BookedSlot } from "@/components/results-list";

function getDaysInRange(startDate: string, endDate: string) {
  const days: string[] = [];
  let current = startDate;
  while (current <= endDate) {
    days.push(current);
    current = addDaysToDateString(current, 1);
  }
  return days;
}

function timeToMinutes(time: string) {
  const [h, m] = time.split(":").map(Number);
  return h * 60 + m;
}

export function AvailabilityGrid({
  slots,
  bookedSlots,
  startDate,
  endDate,
  workingHoursStart,
  workingHoursEnd,
  excludeWeekends,
  timezone,
  onSelectSlot,
  onSelectBooked,
}: {
  slots: Slot[];
  bookedSlots: BookedSlot[];
  startDate: string;
  endDate: string;
  workingHoursStart: string;
  workingHoursEnd: string;
  excludeWeekends: boolean;
  timezone: string;
  onSelectSlot: (slot: Slot) => void;
  /** Opens a booked session so it can be reviewed or cancelled. */
  onSelectBooked: (booked: BookedSlot) => void;
}) {
  const [weekOffset, setWeekOffset] = useState(0);

  const allDays = getDaysInRange(startDate, endDate);
  const totalWeeks = Math.max(1, Math.ceil(allDays.length / 7));
  const weekDays = allDays.slice(weekOffset * 7, weekOffset * 7 + 7);
  const visibleDays = excludeWeekends ? weekDays.filter((d) => !isWeekendDateString(d)) : weekDays;

  const timeRows = generateTimeRows(workingHoursStart, workingHoursEnd);

  // Keyed by wall-clock date+time, which is not unique on a DST fall-back day
  // (e.g. 1:00 AM America/New_York occurs twice on 2026-11-01) — two distinct
  // slots can map to the same cell. The `has` guard deliberately keeps
  // whichever slot was seen first rather than letting response order (and a
  // plain `set`, which would just overwrite) silently decide; the grid has
  // no way to show both in one row. Acceptable for a lean V1 as long as
  // working hours don't extend into that hour on that one day.
  const slotsByCell = new Map<string, Slot>();
  for (const slot of slots) {
    const { date, time } = zonedDateTimeParts(slot.startUnix, timezone);
    const key = `${date}_${time}`;
    if (!slotsByCell.has(key)) slotsByCell.set(key, slot);
  }

  // A booked session's duration (30/45/60 min) doesn't always align to the
  // grid's AVAILABILITY_INTERVAL_MINUTES rows the way a candidate slot does
  // (e.g. a 45-min session doesn't end on a 30-min mark) — so this marks
  // every row whose 30-min window OVERLAPS the booked event at all, not just
  // an exact-match row. A booked event spanning midnight in this timezone
  // (never happens for anything created through this tool — max duration is
  // 60 min) is defensively skipped rather than guessed at.
  const bookedByCell = new Map<string, BookedSlot>();
  for (const booked of bookedSlots) {
    const start = zonedDateTimeParts(booked.startUnix, timezone);
    const end = zonedDateTimeParts(booked.endUnix, timezone);
    if (start.date !== end.date) continue;
    const startMinutes = timeToMinutes(start.time);
    const endMinutes = timeToMinutes(end.time);
    for (const time of timeRows) {
      const rowStart = timeToMinutes(time);
      const rowEnd = rowStart + AVAILABILITY_INTERVAL_MINUTES;
      if (rowStart < endMinutes && rowEnd > startMinutes) {
        bookedByCell.set(`${start.date}_${time}`, booked);
      }
    }
  }

  return (
    <div>
      {totalWeeks > 1 && (
        <div className="flex items-center justify-between pb-3">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={weekOffset === 0}
            onClick={() => setWeekOffset((w) => w - 1)}
          >
            Previous week
          </Button>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={weekOffset >= totalWeeks - 1}
            onClick={() => setWeekOffset((w) => w + 1)}
          >
            Next week
          </Button>
        </div>
      )}

      {visibleDays.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted-foreground">
          No weekdays in this window.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <div
            className="grid min-w-max"
            style={{
              gridTemplateColumns: `5rem repeat(${visibleDays.length}, minmax(5.5rem, 1fr))`,
            }}
          >
            <div />
            {visibleDays.map((day) => (
              <div
                key={day}
                className="border-b border-l border-border px-2 py-2 text-center text-xs font-medium text-foreground"
              >
                {formatDateLabel(day)}
              </div>
            ))}

            {timeRows.map((time) => (
              <div key={time} className="contents">
                <div className="border-b border-border px-2 py-1.5 text-right text-xs text-muted-foreground">
                  {formatTimeLabel(time)}
                </div>
                {visibleDays.map((day) => {
                  const booked = bookedByCell.get(`${day}_${time}`);
                  if (booked) {
                    // A button, not a div: a booked cell is now the way in to
                    // cancelling that session, so it has to be reachable by
                    // keyboard and announce itself as actionable.
                    return (
                      <button
                        key={`${day}_${time}`}
                        type="button"
                        onClick={() => onSelectBooked(booked)}
                        title={`${booked.title} — click to view or cancel`}
                        aria-label={`${booked.title}, booked — view or cancel`}
                        className="truncate border-b border-l border-border bg-white px-1.5 py-1.5 text-left text-[10px] text-foreground ring-1 ring-inset ring-foreground/15 transition-colors hover:bg-secondary"
                      >
                        {booked.title}
                      </button>
                    );
                  }
                  const slot = slotsByCell.get(`${day}_${time}`);
                  return (
                    <button
                      key={`${day}_${time}`}
                      type="button"
                      disabled={!slot}
                      onClick={() => slot && onSelectSlot(slot)}
                      title={slot?.label}
                      aria-label={slot?.label ?? `${formatDateLabel(day)} ${formatTimeLabel(time)} — not available`}
                      className={
                        slot
                          ? "border-b border-l border-border bg-accent py-1.5 transition-colors hover:bg-primary hover:text-primary-foreground"
                          : "border-b border-l border-border bg-secondary py-1.5"
                      }
                    />
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
