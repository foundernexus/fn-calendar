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
import type { Slot, BookedSlot, BusySlot, OwnEventSummary } from "@/components/results-list";

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
  busySlots = [],
  startDate,
  endDate,
  workingHoursStart,
  workingHoursEnd,
  excludeWeekends,
  timezone,
  ownEvents = [],
  leadMemberId = null,
  onSelectSlot,
  onSelectBooked,
  onShiftRange,
}: {
  slots: Slot[];
  bookedSlots: BookedSlot[];
  /** Times somebody is busy that the admin asked to see anyway, so a session can
   * be booked over a hold made somewhere else. Empty unless the search asked for
   * them — an ordinary search draws exactly the grid it always did. */
  busySlots?: BusySlot[];
  /** The viewer's OWN calendar, titles included — never anyone else's. Answers
   * the question the grid couldn't: not "am I free at 3" but "what is it that
   * I'm not free for". */
  ownEvents?: OwnEventSummary[];
  /** The session lead for the search that produced these slots. A busy cell is
   * only offerable when THEY are the only person busy in it — see the cell.
   * Null is safe: every busy cell then stays shut, naming who is busy. */
  leadMemberId?: number | null;
  startDate: string;
  endDate: string;
  workingHoursStart: string;
  workingHoursEnd: string;
  excludeWeekends: boolean;
  timezone: string;
  onSelectSlot: (slot: Slot) => void;
  /** Opens a booked session so it can be reviewed or cancelled. */
  onSelectBooked: (booked: BookedSlot) => void;
  /** Moves the searched range a week either way and searches again.
   *
   * Without it, paging stops at the edge of whatever was searched — the default
   * is a fortnight, so "Next week" greyed out after two clicks and reaching a
   * date in January meant typing it into the date field. With it, the arrows
   * keep going as far as anyone wants to look.
   *
   * Why a new search rather than one long window: every search reads everyone's
   * calendars. Loading a year up front to page through it would be minutes of
   * work for a glance, so pages are fetched as they are asked for — the same
   * thing a calendar app does. */
  onShiftRange?: (direction: -1 | 1) => void;
}) {
  const [weekOffset, setWeekOffset] = useState(0);

  const allDays = getDaysInRange(startDate, endDate);
  const totalWeeks = Math.max(1, Math.ceil(allDays.length / 7));
  const weekDays = allDays.slice(weekOffset * 7, weekOffset * 7 + 7);
  const atStart = weekOffset === 0;
  const atEnd = weekOffset >= totalWeeks - 1;
  const visibleDays = excludeWeekends ? weekDays.filter((d) => !isWeekendDateString(d)) : weekDays;

  // Booked sessions the grid has no column for. "Exclude weekends" hides whole
  // days, and a session booked on one of them became invisible AND
  // unreachable — the only way to open a session is its cell, so it could not
  // be cancelled or moved from anywhere in the app. Surfacing them as rows
  // below the grid keeps every booked session reachable no matter how the
  // search is filtered.
  const hiddenBooked = bookedSlots.filter(
    (b) => !visibleDays.includes(zonedDateTimeParts(b.startUnix, timezone).date)
  );

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
  //
  // The viewer's own events are mapped the same way. An all-day entry is left
  // out on purpose: it would paint every row of the day and bury the meetings
  // that actually explain the gaps.
  // All-day entries are collected separately rather than painted into cells:
  // spread across every row they would bury the meetings that actually explain
  // the gaps. They go under the day heading instead — which matters, because an
  // all-day block is exactly what someone noticed missing here. Google marks
  // these free by default, so free/busy never reports them and the day still
  // reads as open; seeing it is the whole point.
  const allDayByDate = new Map<string, string[]>();
  for (const own of ownEvents) {
    if (!own.allDay) continue;
    // An all-day event ends at midnight on the FOLLOWING day, so its own end is
    // one second short of being counted as a day of its own.
    let cursor = zonedDateTimeParts(own.startUnix, timezone).date;
    const lastDate = zonedDateTimeParts(own.endUnix - 1, timezone).date;
    for (let guard = 0; guard < 60 && cursor <= lastDate; guard++) {
      allDayByDate.set(cursor, [...(allDayByDate.get(cursor) ?? []), own.title]);
      cursor = addDaysToDateString(cursor, 1);
    }
  }

  const ownByCell = new Map<string, string>();
  for (const own of ownEvents) {
    if (own.allDay) continue;
    const start = zonedDateTimeParts(own.startUnix, timezone);
    const end = zonedDateTimeParts(own.endUnix, timezone);
    if (start.date !== end.date) continue;
    const startMinutes = timeToMinutes(start.time);
    const endMinutes = timeToMinutes(end.time);
    for (const time of timeRows) {
      const rowStart = timeToMinutes(time);
      const rowEnd = rowStart + AVAILABILITY_INTERVAL_MINUTES;
      if (rowStart < endMinutes && rowEnd > startMinutes) {
        // First one wins, so a long meeting keeps its title on every row it
        // covers rather than being overwritten by whatever comes after it.
        const key = `${start.date}_${time}`;
        if (!ownByCell.has(key)) ownByCell.set(key, own.title);
      }
    }
  }

  // Same keying and the same first-wins guard as slotsByCell above, for the same
  // DST reason. These can never collide with slotsByCell: the two lists are
  // complements of one another over the same candidates (see computeBusySlots).
  const busyByCell = new Map<string, BusySlot>();
  for (const slot of busySlots) {
    const { date, time } = zonedDateTimeParts(slot.startUnix, timezone);
    const key = `${date}_${time}`;
    if (!busyByCell.has(key)) busyByCell.set(key, slot);
  }

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
      {(totalWeeks > 1 || onShiftRange) && (
        <div className="flex items-center justify-between pb-3">
          {/* At the edge of the searched range the arrows move the range itself
              rather than going dead, so paging forward never stops. */}
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={atStart && !onShiftRange}
            onClick={() => (atStart ? onShiftRange?.(-1) : setWeekOffset((w) => w - 1))}
          >
            Previous week
          </Button>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={atEnd && !onShiftRange}
            onClick={() => (atEnd ? onShiftRange?.(1) : setWeekOffset((w) => w + 1))}
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
          {/* Minimum width comes from the COLUMNS, never from cell content.
              It used to be min-w-max, which asks the browser to fit the widest
              thing inside on one line — fine while every cell was empty, but
              the first booked session put a title in one, and the whole grid
              stretched to fit that title, forcing the page sideways. `truncate`
              on the cell can't prevent it, because max-content sizing measures
              the text before it is clipped.
              This keeps the original intent — columns never get crushed below
              5.5rem, and the container scrolls when they don't fit — without
              letting one long session title decide how wide the week is. */}
          <div
            className="grid"
            style={{
              gridTemplateColumns: `5rem repeat(${visibleDays.length}, minmax(5.5rem, 1fr))`,
              minWidth: `calc(5rem + ${visibleDays.length} * 5.5rem)`,
            }}
          >
            <div />
            {visibleDays.map((day) => (
              <div
                key={day}
                className="border-b border-l border-border px-2 py-2 text-center text-xs font-medium text-foreground"
              >
                {formatDateLabel(day)}
                {(allDayByDate.get(day)?.length ?? 0) > 0 && (
                  <span
                    className="mt-0.5 block truncate text-[10px] leading-tight font-normal text-muted-foreground"
                    title={allDayByDate.get(day)!.join(", ")}
                  >
                    {allDayByDate.get(day)!.join(", ")}
                  </span>
                )}
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
                        // min-w-0 belt and braces: a grid item's default
                        // minimum size is its content, so without this a long
                        // title can still push its own column wide even though
                        // the grid no longer sizes itself to content.
                        className="min-w-0 truncate border-b border-l border-border bg-card px-1.5 py-1.5 text-left text-xs text-foreground ring-1 ring-inset ring-foreground/15 transition-colors hover:bg-muted"
                      >
                        {booked.title}
                      </button>
                    );
                  }
                  const slot = slotsByCell.get(`${day}_${time}`);
                  // Only ever shown on a cell that ISN'T offered as free — the
                  // point is to explain a gap, and a title over a bookable slot
                  // would just be in the way of clicking it. A busy-but-bookable
                  // cell still wants it: there the title IS the explanation of
                  // what you are about to book over, which is the whole case
                  // this was built for.
                  const mine = slot ? undefined : ownByCell.get(`${day}_${time}`);
                  const busy = slot ? undefined : busyByCell.get(`${day}_${time}`);
                  if (busy) {
                    const who = busy.busyNames.join(", ");
                    // The only thing standing in the way is the session lead's
                    // own calendar — a hold they made themselves, somewhere
                    // else. That is the one case worth offering, and the whole
                    // reason this exists: the block IS the session.
                    //
                    // The moment anybody ELSE is busy, the cell stays shut. Not
                    // because it couldn't be booked, but because nobody wants
                    // to: the question at these cells is "is this person free",
                    // and "no" is a complete answer. Offering a button there
                    // would invite exactly the double-booking nobody asked for.
                    const onlyTheLead =
                      leadMemberId !== null &&
                      busy.busyMemberIds.length > 0 &&
                      busy.busyMemberIds.every((id) => id === leadMemberId);

                    if (!onlyTheLead) {
                      // Shut, but not silent. Naming who is busy is the entire
                      // point — it turns a dead grey square into the answer.
                      return (
                        <button
                          key={`${day}_${time}`}
                          type="button"
                          disabled
                          title={`${who} ${busy.busyNames.length === 1 ? "is" : "are"} busy`}
                          aria-label={`${formatDateLabel(day)} ${formatTimeLabel(time)} — ${who} ${
                            busy.busyNames.length === 1 ? "is" : "are"
                          } busy`}
                          className="min-w-0 truncate border-b border-l border-border bg-secondary px-1.5 py-1.5 text-left text-[11px] leading-tight text-muted-foreground"
                        >
                          {who}
                        </button>
                      );
                    }
                    // Whether the ONLY person busy here is the one reading the
                    // screen. That is the case this whole feature was built for
                    // — a hold you made elsewhere, sitting on your own calendar
                    // — and it is the one case where your own event title is the
                    // more useful thing to show, because it says what you'd be
                    // booking over.
                    //
                    // The moment anybody else is busy too, the names win. The
                    // question at one of these cells is "can I still get the
                    // others here", and a cell reading "Edan Shahar" answers a
                    // question nobody asked while hiding the one they did.
                    //
                    return (
                      <button
                        key={`${day}_${time}`}
                        type="button"
                        onClick={() => onSelectSlot(busy)}
                        title={`Only your own calendar is busy${mine ? ` (${mine})` : ""} — everyone else is free. Click to book.`}
                        // Spelled out, because the visual difference between
                        // this cell and the two beside it is the entire safety
                        // mechanism and a screen reader gets none of it.
                        aria-label={`${formatDateLabel(day)} ${formatTimeLabel(time)} — only your own calendar is busy${
                          mine ? `, with ${mine}` : ""
                        }. Everyone else is free. Click to book.`}
                        // Deliberately not bg-accent and not hover:bg-primary:
                        // those two are the whole visual vocabulary of "everyone
                        // free", and this cell must never be mistaken for one.
                        // It stays the grey of a blocked cell and earns a dashed
                        // outline instead — a third thing, told apart at a
                        // glance rather than by shade.
                        className="min-w-0 truncate border-b border-l border-border bg-secondary px-1.5 py-1.5 text-left text-[11px] leading-tight text-muted-foreground outline-1 -outline-offset-2 outline-dashed outline-foreground/40 transition-colors hover:bg-secondary/60 hover:text-foreground"
                      >
                        {mine ?? who}
                      </button>
                    );
                  }
                  return (
                    <button
                      key={`${day}_${time}`}
                      type="button"
                      disabled={!slot}
                      onClick={() => slot && onSelectSlot(slot)}
                      title={slot?.label ?? mine}
                      aria-label={
                        slot?.label ??
                        `${formatDateLabel(day)} ${formatTimeLabel(time)} — not available${mine ? `: ${mine}` : ""}`
                      }
                      className={
                        slot
                          ? "border-b border-l border-border bg-accent py-1.5 transition-colors hover:bg-primary hover:text-primary-foreground"
                          : "min-w-0 truncate border-b border-l border-border bg-secondary px-1.5 py-1.5 text-left text-[11px] leading-tight text-muted-foreground"
                      }
                    >
                      {mine}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      )}

      {hiddenBooked.length > 0 && (
        <div className="mt-4 rounded-lg border border-border bg-secondary/40 p-3">
          <p className="text-xs font-medium tracking-[0.04em] text-muted-foreground uppercase">
            Booked outside this view
          </p>
          <ul className="mt-2 space-y-1">
            {hiddenBooked.map((booked) => {
              const { date } = zonedDateTimeParts(booked.startUnix, timezone);
              return (
                <li key={booked.id}>
                  <button
                    type="button"
                    onClick={() => onSelectBooked(booked)}
                    className="text-left text-sm text-foreground underline-offset-2 hover:underline"
                  >
                    {booked.title}
                    <span className="ml-2 text-xs text-muted-foreground">
                      {formatDateLabel(date)}
                      {isWeekendDateString(date) && excludeWeekends
                        ? " — weekends are excluded from this search"
                        : ""}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
