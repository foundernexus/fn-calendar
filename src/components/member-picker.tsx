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

/** These pickers used to be documented as only ever receiving `connected: true`
 * members. That is no longer true, and the reason is worth keeping: an
 * introduction is arranged with somebody who has not joined the tool, so
 * refusing to list them didn't protect the availability check — it just made
 * the booking impossible and pushed it into Google Calendar by hand.
 *
 * The session lead picker still receives connected members only, and must: the
 * session is created on their calendar. For everyone else, unconnected means
 * "invited, not checked" — which is a real, useful state, so it's labelled
 * rather than hidden. */

/** Says out loud that this person's calendar was never consulted.
 *
 * Shown on the row and on the trigger, because a picker that looks identical
 * whether or not a slot was verified against someone is how you book over
 * somebody's holiday and only find out from them. */
function NotConnected({ label = "not connected" }: { label?: string }) {
  return (
    <span className="shrink-0 rounded-sm bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
      {label}
    </span>
  );
}

/** The address the invite will actually arrive at, which is NOT necessarily
 * the one they're registered under.
 *
 * Someone registered as court@company.com who connected a personal Gmail gets
 * the invite at the Gmail — booking deliberately sends to the connected
 * calendar's address, because sending to the registered one would deliver an
 * invite to a calendar that was never checked as free. Showing members.email
 * here therefore named an address the session might never reach, and someone
 * holding two calendars makes that likelier rather than rarer.
 *
 * Falls back to the registered address when nothing is connected — which is
 * now a state these pickers do show, and exactly the address the invite goes
 * to in that case (see resolvedEmail in the events route). */
function inviteAddress(m: MemberWithConnection) {
  return m.grantEmail ?? m.email;
}

export function MemberSelect({
  id,
  members,
  value,
  onChange,
  placeholder,
  emptyText = "Nobody matches.",
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
              {selected ? `${selected.fullName} — ${inviteAddress(selected)}` : placeholder}
            </span>
            {selected && !selected.connected && <NotConnected />}
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
                  value={`${m.fullName} ${m.email} ${inviteAddress(m)}`}
                  onSelect={() => {
                    onChange(m.id === value ? null : m.id);
                    setOpen(false);
                  }}
                >
                  <Check className={cn("size-4", m.id === value ? "opacity-100" : "opacity-0")} />
                  <span>{m.fullName}</span>
                  <span className="truncate text-muted-foreground">{inviteAddress(m)}</span>
                  {!m.connected && <NotConnected />}
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
   * added as a guest (they're already invited automatically).
   *
   * The advisor needs no equivalent here: unlike the lead (who is picked from
   * the same pool of connected members this list draws on), advisors are
   * filtered out of `members` before it ever reaches this component. */
  excludeId?: number | null;
  placeholder: string;
}) {
  const [open, setOpen] = useState(false);
  const selectable = members.filter((m) => m.id !== excludeId);
  const selected = selectable.filter((m) => value.includes(m.id));
  const unconnectedCount = selected.filter((m) => !m.connected).length;

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
            {/* Counted rather than badged per name: the trigger collapses to one
                line, and three separate "not connected" chips would push the
                names out of view to say one thing three times. */}
            {unconnectedCount > 0 && (
              <NotConnected label={`${unconnectedCount} not connected`} />
            )}
            <ChevronsUpDown className="size-4 shrink-0 opacity-50" />
          </Button>
        }
      />
      <PopoverContent className="w-(--anchor-width) p-0" align="start">
        <Command>
          <CommandInput placeholder="Search name or email…" />
          <CommandList>
            <CommandEmpty>Nobody matches.</CommandEmpty>
            <CommandGroup>
              {selectable.map((m) => {
                const checked = value.includes(m.id);
                return (
                  <CommandItem
                    key={m.id}
                    value={`${m.fullName} ${m.email} ${inviteAddress(m)}`}
                    onSelect={() => toggle(m.id)}
                  >
                    <Check className={cn("size-4", checked ? "opacity-100" : "opacity-0")} />
                    <span>{m.fullName}</span>
                    <span className="truncate text-muted-foreground">{inviteAddress(m)}</span>
                    {!m.connected && <NotConnected />}
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
