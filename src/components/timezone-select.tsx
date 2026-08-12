"use client";

import { useState } from "react";
import { Check, ChevronsUpDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { TIMEZONE_OPTIONS, timezoneLabel } from "@/lib/timezones";

/** Searchable single-select over the full IANA timezone list — mirrors
 * MemberSelect's Popover+Command pattern in member-picker.tsx. Search matches
 * the city/region embedded in the IANA string (e.g. "Berlin"), not country
 * names ("Germany" won't match "Europe/Berlin") — see lib/timezones.ts. */
export function TimezoneSelect({
  id,
  value,
  onChange,
  placeholder = "Select your timezone…",
}: {
  id?: string;
  value: string | null;
  onChange: (tz: string) => void;
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            id={id}
            type="button"
            variant="secondary"
            role="combobox"
            aria-expanded={open}
            aria-label={placeholder}
            className="w-full justify-between font-normal"
          >
            <span className={cn("truncate", !value && "text-muted-foreground")}>
              {value ? timezoneLabel(value) : placeholder}
            </span>
            <ChevronsUpDown className="size-4 shrink-0 opacity-50" />
          </Button>
        }
      />
      <PopoverContent className="w-(--anchor-width) p-0" align="start">
        <Command>
          <CommandInput placeholder="Search city or region…" />
          <CommandList>
            <CommandEmpty>No matching timezone.</CommandEmpty>
            <CommandGroup>
              {TIMEZONE_OPTIONS.map(({ tz, label }) => (
                <CommandItem
                  key={tz}
                  value={`${tz} ${label}`}
                  onSelect={() => {
                    onChange(tz);
                    setOpen(false);
                  }}
                >
                  <Check className={cn("size-4", tz === value ? "opacity-100" : "opacity-0")} />
                  <span>{label}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
