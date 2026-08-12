"use client";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { generateTimeRows, formatTimeLabel } from "@/lib/time";

// Every half-hour mark in a day, "00:00".."23:30" — same grid the find-a-time
// search itself uses (AVAILABILITY_INTERVAL_MINUTES).
const TIME_OPTIONS = generateTimeRows("00:00", "23:59");

/** A 12-hour AM/PM time picker that always renders the same way regardless
 * of the visitor's browser/OS locale — unlike a native `<input type="time">`,
 * whose displayed format (24h "14:00" vs 12h "2:00 PM") follows the
 * browser's regional settings and can't be reliably forced. We render every
 * label ourselves via formatTimeLabel, so it's always "2:00 PM". */
export function TimeSelect({
  id,
  value,
  onChange,
}: {
  id?: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <Select
      items={Object.fromEntries(TIME_OPTIONS.map((t) => [t, formatTimeLabel(t)]))}
      value={value}
      onValueChange={(v) => v && onChange(v)}
    >
      <SelectTrigger id={id} className="w-[6.5rem]">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {TIME_OPTIONS.map((t) => (
          <SelectItem key={t} value={t}>
            {formatTimeLabel(t)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
