/** What we ask each person for, and how we check we actually got it.
 *
 * Two tiers, because two different jobs are being done:
 *
 *   read  — everyone. Enough to answer "when is this person busy", nothing more.
 *   write — session leads and admins only. The session is created on ONE
 *           calendar, the organiser's, and everyone else is an attendee invited
 *           by email address. Delivering that invite needs no permission from
 *           the attendee at all, so asking a founder or advisor for write access
 *           was asking for something we would never use.
 *
 * This replaced a single list, identical for everyone, inherited from the Nylas
 * connector. Keeping it identical was the right call during the switch — one
 * variable at a time — but it meant every member granted "see and download any
 * calendar" plus "edit events on all your calendars" so that we could read
 * free/busy. An advisor noticed and declined the broad read, which is entirely
 * reasonable, and the app then failed for him with a 403 nobody saw for days.
 * Both halves of that are fixed here: ask for less, and notice when we didn't
 * get it. */

export type CalendarAccess = "read" | "write";

const GOOGLE = "https://www.googleapis.com/auth/";

/** One entry per thing the app genuinely does.
 *
 * `satisfiedBy` is ordered narrowest first and lists every scope that grants the
 * capability, not just the one we request. Someone who consented to a broader
 * scope in the past — everyone connected before this change — still has it in
 * their token, and must not be told their working calendar is broken. */
type Capability = { readonly need: string; readonly satisfiedBy: readonly string[] };

const CAPABILITIES: Record<"google" | "microsoft", Record<CalendarAccess, readonly Capability[]>> = {
  google: {
    read: [
      {
        need: "see the list of your calendars",
        satisfiedBy: [
          `${GOOGLE}calendar.calendarlist.readonly`,
          `${GOOGLE}calendar.readonly`,
          `${GOOGLE}calendar`,
        ],
      },
      {
        need: "see when you're busy",
        satisfiedBy: [`${GOOGLE}calendar.freebusy`, `${GOOGLE}calendar.readonly`, `${GOOGLE}calendar`],
      },
    ],
    write: [
      {
        need: "add sessions to your calendar",
        satisfiedBy: [`${GOOGLE}calendar.events`, `${GOOGLE}calendar`],
      },
    ],
  },
  microsoft: {
    read: [
      {
        need: "see when you're busy",
        // Calendars.ReadBasic is deliberately NOT in this list, even though
        // Microsoft's reference page names it the least-privileged permission
        // for getSchedule. It does not work: a personal Outlook account that
        // granted exactly ReadBasic gets
        //   403 ErrorAccessDenied "Access is denied. Check credentials..."
        // from /me/calendar/getSchedule. Observed in production on 2026-08-20
        // after narrowing to it on the strength of the documentation alone.
        //
        // The same page also calls getSchedule unsupported for delegated
        // personal accounts, which is equally wrong — it works with
        // Calendars.Read and Calendars.ReadWrite. Treat that page as a rough
        // guide and test the actual account type before trusting it.
        //
        // Listed here rather than only in requestedScopes because a token
        // holding just ReadBasic genuinely cannot do the job: it has to fail
        // the capability check and prompt a reconnect, not be waved through.
        satisfiedBy: ["Calendars.Read", "Calendars.ReadWrite"],
      },
    ],
    write: [{ need: "add sessions to your calendar", satisfiedBy: ["Calendars.ReadWrite"] }],
  },
};

/** The scopes to put on the consent screen.
 *
 * Google's userinfo.email and Microsoft's User.Read are here because the
 * callback has to know WHOSE calendar it just connected — without an address
 * there is no member to bind the connection to. offline_access is what makes
 * Microsoft issue a refresh token at all. */
export function requestedScopes(provider: "google" | "microsoft", access: CalendarAccess) {
  if (provider === "microsoft") {
    return [
      "offline_access",
      "User.Read",
      // Calendars.Read, not Calendars.ReadBasic — see the note above. ReadBasic
      // is the documented minimum for getSchedule and returns 403 in practice.
      access === "write" ? "Calendars.ReadWrite" : "Calendars.Read",
    ];
  }
  const scopes = [
    `${GOOGLE}calendar.calendarlist.readonly`,
    `${GOOGLE}calendar.freebusy`,
    `${GOOGLE}userinfo.email`,
  ];
  if (access === "write") scopes.push(`${GOOGLE}calendar.events`);
  return scopes;
}

/** Compares scope strings by their last path segment.
 *
 * Providers are inconsistent about the form they hand back: Microsoft may return
 * `Calendars.ReadBasic` or `https://graph.microsoft.com/Calendars.ReadBasic` for
 * the same grant. The tail is the part that identifies the permission in both. */
function tail(scope: string) {
  const lower = scope.trim().toLowerCase();
  return lower.slice(lower.lastIndexOf("/") + 1);
}

/** Which of the capabilities we need are NOT covered by what was granted.
 *
 * Returns human-readable phrases, not scope URLs — the caller puts these in
 * front of the person who just clicked through the consent screen, and
 * "https://www.googleapis.com/auth/calendar.freebusy" tells them nothing about
 * which checkbox to leave ticked next time.
 *
 * An empty `granted` means the provider told us nothing about scopes rather than
 * that it granted none. Treated as "can't tell, don't block": refusing a
 * connection on the strength of a field a provider simply didn't send would lock
 * people out over nothing, and the availability search still fails loudly and
 * names them if the access really is missing. */
export function missingCapabilities(
  provider: "google" | "microsoft",
  access: CalendarAccess,
  granted: readonly string[] | undefined
): string[] {
  // Undefined and empty mean the same thing and must both be tolerated: the
  // provider told us nothing about scopes. `scope` is not a guaranteed field on
  // a token response, and blocking a connection over its absence would lock
  // people out of a working calendar for no reason.
  if (!granted || granted.length === 0) return [];

  const held = new Set(granted.map(tail));
  const required = [
    ...CAPABILITIES[provider].read,
    ...(access === "write" ? CAPABILITIES[provider].write : []),
  ];

  return required
    .filter((capability) => !capability.satisfiedBy.some((scope) => held.has(tail(scope))))
    .map((capability) => capability.need);
}
