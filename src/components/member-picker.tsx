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
import type { MemberWithConnection } from "@/db/queries";

/** Both pickers below only ever take `members` that are already filtered to
 * `connected: true` by the caller — selecting someone whose calendar isn't
 * connected would make the whole point of collective availability checking
 * meaningless (there'd be nothing to check them against). */

export function MemberSelect({
  id,
  members,
  value,
  onChange,
  placeholder,
  emptyText = "No connected calendars match.",
}: {
  id?: string;
  members: MemberWithConnection[];
  value: number | null;
  onChange: (id: number | null) => void;
  placeholder: string;
  emptyText?: string;
}) {
  const [open, setOpen] = useState(false);
  const selected = members.find((m) => m.id === value);

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
            <span className={cn("truncate", !selected && "text-muted-foreground")}>
              {selected ? `${selected.fullName} — ${selected.email}` : placeholder}
            </span>
            <ChevronsUpDown className="size-4 shrink-0 opacity-50" />
          </Button>
        }
      />
      <PopoverContent className="w-(--anchor-width) p-0" align="start">
        <Command>
          <CommandInput placeholder="Search name or email…" />
          <CommandList>
            <CommandEmpty>{emptyText}</CommandEmpty>
            <CommandGroup>
              {members.map((m) => (
                <CommandItem
                  key={m.id}
                  value={`${m.fullName} ${m.email}`}
                  onSelect={() => {
                    onChange(m.id === value ? null : m.id);
                    setOpen(false);
                  }}
                >
                  <Check className={cn("size-4", m.id === value ? "opacity-100" : "opacity-0")} />
                  <span>{m.fullName}</span>
                  <span className="text-muted-foreground">{m.email}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

export function MemberMultiSelect({
  id,
  members,
  value,
  onChange,
  excludeId,
  placeholder,
}: {
  id?: string;
  members: MemberWithConnection[];
  value: number[];
  onChange: (ids: number[]) => void;
  /** The session lead, if already picked — hidden here so they can't also be
   * added as a guest (they're already invited automatically). */
  excludeId?: number | null;
  placeholder: string;
}) {
  const [open, setOpen] = useState(false);
  const selectable = members.filter((m) => m.id !== excludeId);
  const selected = selectable.filter((m) => value.includes(m.id));

  function toggle(memberId: number) {
    onChange(value.includes(memberId) ? value.filter((v) => v !== memberId) : [...value, memberId]);
  }

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
            className="h-auto min-h-8 w-full justify-between py-1.5 font-normal"
          >
            <span className={cn("truncate text-left", selected.length === 0 && "text-muted-foreground")}>
              {selected.length === 0
                ? placeholder
                : selected.map((m) => m.fullName).join(", ")}
            </span>
            <ChevronsUpDown className="size-4 shrink-0 opacity-50" />
          </Button>
        }
      />
      <PopoverContent className="w-(--anchor-width) p-0" align="start">
        <Command>
          <CommandInput placeholder="Search name or email…" />
          <CommandList>
            <CommandEmpty>No connected calendars match.</CommandEmpty>
            <CommandGroup>
              {selectable.map((m) => {
                const checked = value.includes(m.id);
                return (
                  <CommandItem
                    key={m.id}
                    value={`${m.fullName} ${m.email}`}
                    onSelect={() => toggle(m.id)}
                  >
                    <Check className={cn("size-4", checked ? "opacity-100" : "opacity-0")} />
                    <span>{m.fullName}</span>
                    <span className="text-muted-foreground">{m.email}</span>
                  </CommandItem>
                );
              })}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
