"use client";

import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import type { MemberSession } from "@/db/queries";

/** Formats in the SESSION's timezone, not the viewer's. The event row carries
 * the zone it was booked in, and an advisor comparing this against the invite
 * in their calendar client should read the same wall-clock time in both. */
function formatParts(session: MemberSession) {
  const date = new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    day: "numeric",
    month: "long",
    timeZone: session.timezone,
  }).format(session.startsAt);
  const start = new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: session.timezone,
  }).format(session.startsAt);
  const end = new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: session.timezone,
    timeZoneName: "short",
  }).format(session.endsAt);
  const minutes = Math.round((session.endsAt.getTime() - session.startsAt.getTime()) / 60000);
  return { date, time: `${start} – ${end}`, minutes };
}

function SessionRow({ session }: { session: MemberSession }) {
  const [open, setOpen] = useState(false);
  const cancelled = session.status === "cancelled";
  const { date, time, minutes } = formatParts(session);

  return (
    <li className="py-1 first:pt-0 last:pb-0">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-start justify-between gap-4 rounded-lg px-2 py-3 text-left transition-colors hover:bg-muted"
      >
        <div className="min-w-0">
          <p
            className={`text-sm font-medium ${
              cancelled ? "text-muted-foreground line-through" : "text-foreground"
            }`}
          >
            {session.title}
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {date} · {time} · {session.attendees.length}{" "}
            {session.attendees.length === 1 ? "participant" : "participants"}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {session.role === "advisor" && (
            <Badge className="bg-accent text-accent-foreground">Advisor</Badge>
          )}
          {cancelled && <Badge className="bg-secondary text-secondary-foreground">Cancelled</Badge>}
          <ChevronDown
            className={`size-4 text-muted-foreground transition-transform ${
              open ? "rotate-180" : ""
            }`}
          />
        </div>
      </button>

      {open && (
        <div className="mt-1 space-y-4 rounded-lg bg-secondary/40 px-4 py-4 text-sm">
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <p className="text-xs text-muted-foreground">When</p>
              <p className="text-foreground">{date}</p>
              <p className="text-foreground">
                {time} · {minutes} min
              </p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Session lead</p>
              <p className="text-foreground">{session.organizerName}</p>
              <p className="text-xs text-muted-foreground">{session.organizerEmail}</p>
            </div>
          </div>

          {session.description && (
            <div>
              <p className="text-xs text-muted-foreground">Description</p>
              {/* whitespace-pre-line: the admin types this into a textarea, so
                  their line breaks are meaningful. */}
              <p className="whitespace-pre-line text-foreground">{session.description}</p>
            </div>
          )}

          {session.meetingUrl && (
            <div>
              <p className="text-xs text-muted-foreground">Meeting link</p>
              <a
                href={session.meetingUrl}
                target="_blank"
                rel="noreferrer"
                className="break-all text-primary underline"
              >
                {session.meetingUrl}
              </a>
            </div>
          )}

          {/* No guest list. An advisor is told a session's shape — when, how
              long, who is leading, how many people — and nothing about which
              founders are in the room. That is the members' business, and it is
              not an advisor's to browse from a dashboard.
              The count stays: it exposes nobody and it is what an advisor needs
              to prepare for two people versus twenty. */}
        </div>
      )}
    </li>
  );
}

export function AdvisorSessionList({ sessions }: { sessions: MemberSession[] }) {
  if (sessions.length === 0) {
    return (
      <p className="rounded-lg border border-border bg-card p-6 text-sm text-muted-foreground shadow-card">
        Nothing booked yet. Once your availability is saved, admins can book you into sessions and
        they&apos;ll show up here.
      </p>
    );
  }

  // Split on "now" at render time. This is a force-dynamic page, so there's no
  // cached HTML to go stale — a session that started a minute ago correctly
  // moves to Past on the next load.
  const now = Date.now();
  const upcoming = sessions.filter((s) => s.endsAt.getTime() >= now);
  const past = sessions.filter((s) => s.endsAt.getTime() < now);

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-border bg-card p-6 shadow-card">
        <p className="text-base font-semibold text-foreground">Upcoming</p>
        {upcoming.length === 0 ? (
          <p className="mt-2 text-sm text-muted-foreground">Nothing coming up.</p>
        ) : (
          <ul className="mt-3 divide-y divide-border">
            {/* getSessionsForMember returns newest-first, which is right for
                past sessions but backwards for upcoming — the next one should
                be at the top. */}
            {[...upcoming]
              .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime())
              .map((s) => (
                <SessionRow key={s.id} session={s} />
              ))}
          </ul>
        )}
      </div>

      {past.length > 0 && (
        <div className="rounded-lg border border-border bg-card p-6 shadow-card">
          <p className="text-base font-semibold text-foreground">Past</p>
          <ul className="mt-3 divide-y divide-border">
            {past.map((s) => (
              <SessionRow key={s.id} session={s} />
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
