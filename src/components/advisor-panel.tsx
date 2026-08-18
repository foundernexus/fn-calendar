"use client";

import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { MemberSettingsForm } from "@/components/member-settings-form";
import { AdvisorSessionList } from "@/components/advisor-session-list";
import type { MemberSession } from "@/db/queries";

type Tab = "availability" | "sessions";

/** Two views behind a tab bar rather than one long scroll. An advisor uses
 * these on completely different occasions — availability is set once and
 * revisited rarely, sessions get checked repeatedly — so stacking them meant
 * scrolling past a form you weren't there for every single time. */
export function AdvisorPanel({
  fullName,
  timezone,
  initialAvailability,
  connection,
  needsReconnect,
  sessions,
}: {
  fullName: string;
  timezone: string | null;
  initialAvailability: { dayOfWeek: number; startTime: string; endTime: string }[];
  connection: { provider: string; grantEmail: string } | null;
  needsReconnect: boolean;
  sessions: MemberSession[];
}) {
  const [tab, setTab] = useState<Tab>("availability");

  // Counted here rather than in the list so the tab can advertise it — the
  // whole reason to open this panel is usually "what's coming up".
  const upcomingCount = sessions.filter((s) => s.endsAt.getTime() >= Date.now()).length;

  const tabs: { id: Tab; label: string; count?: number }[] = [
    { id: "availability", label: "Availability" },
    { id: "sessions", label: "Sessions", count: upcomingCount },
  ];

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">{fullName}</h1>
          <p className="mt-1.5 text-sm text-muted-foreground">
            {tab === "availability"
              ? "Founders are only ever offered times that work for you."
              : "Sessions you've been booked into."}
          </p>
        </div>
        <Badge className="bg-accent text-accent-foreground">Advisor</Badge>
      </div>

      {/* Underline tabs rather than buttons: this is navigation between two
          views of the same page, and a filled button would read as an action. */}
      <div
        role="tablist"
        aria-label="Advisor sections"
        className="mt-5 flex gap-6 border-b border-border"
      >
        {tabs.map((t) => {
          const active = t.id === tab;
          return (
            <button
              key={t.id}
              role="tab"
              type="button"
              aria-selected={active}
              onClick={() => setTab(t.id)}
              className={`-mb-px flex items-center gap-2 border-b-2 px-1 pb-3 text-sm font-medium transition-colors ${
                active
                  ? "border-foreground text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              }`}
            >
              {t.label}
              {/* Only when there's something to see — a "0" badge is noise. */}
              {!!t.count && (
                <span className="rounded-full bg-secondary px-2 py-0.5 text-xs text-secondary-foreground">
                  {t.count}
                </span>
              )}
            </button>
          );
        })}
      </div>

      <div className="mt-6">
        {tab === "availability" ? (
          <MemberSettingsForm
            fullName={fullName}
            timezone={timezone}
            initialAvailability={initialAvailability}
            connection={connection}
            needsReconnect={needsReconnect}
            // Advisors are the scarce side of the marketplace — capping how
            // many sessions they'll take is the point. Founders don't get this.
          />
        ) : (
          <AdvisorSessionList sessions={sessions} />
        )}
      </div>
    </div>
  );
}
