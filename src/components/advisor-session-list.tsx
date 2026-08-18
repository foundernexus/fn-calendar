import { Badge } from "@/components/ui/badge";
import type { MemberSession } from "@/db/queries";

/** Formats in the SESSION's timezone, not the viewer's. The event row carries
 * the zone it was booked in, and an advisor comparing what they see here
 * against the invite in their calendar client should read the same wall-clock
 * time in both places. */
function formatSlot(session: MemberSession) {
  const date = new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: session.timezone,
  }).format(session.startsAt);
  const time = new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: session.timezone,
    timeZoneName: "short",
  });
  const start = new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: session.timezone,
  }).format(session.startsAt);
  return `${date}, ${start} – ${time.format(session.endsAt)}`;
}

function SessionRow({ session }: { session: MemberSession }) {
  const cancelled = session.status === "cancelled";
  return (
    <li className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-3 first:pt-0 last:pb-0">
      <div className="min-w-0">
        <p
          className={`text-sm font-medium ${
            cancelled ? "text-muted-foreground line-through" : "text-foreground"
          }`}
        >
          {session.title}
        </p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {formatSlot(session)} · led by {session.organizerName} ·{" "}
          {session.attendeeCount} {session.attendeeCount === 1 ? "participant" : "participants"}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        {session.role === "advisor" && (
          <Badge className="bg-accent text-accent-foreground">Advisor</Badge>
        )}
        {cancelled && <Badge className="bg-secondary text-secondary-foreground">Cancelled</Badge>}
      </div>
    </li>
  );
}

export function AdvisorSessionList({ sessions }: { sessions: MemberSession[] }) {
  if (sessions.length === 0) {
    return (
      <p className="rounded-lg border border-border bg-card p-5 text-sm text-muted-foreground shadow-card">
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
      <div className="rounded-lg border border-border bg-card p-5 shadow-card">
        <p className="text-sm font-medium text-foreground">Upcoming</p>
        {upcoming.length === 0 ? (
          <p className="mt-2 text-sm text-muted-foreground">Nothing coming up.</p>
        ) : (
          <ul className="mt-2 divide-y divide-border">
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
        <div className="rounded-lg border border-border bg-card p-5 shadow-card">
          <p className="text-sm font-medium text-foreground">Past</p>
          <ul className="mt-2 divide-y divide-border">
            {past.map((s) => (
              <SessionRow key={s.id} session={s} />
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
