/** Turning "what the provider said" into "what we store".
 *
 * Pure and I/O-free on purpose: this is the part with the actual disagreement
 * in it — two providers, seven spellings, one enum — and it is the part worth
 * testing exhaustively without a network anywhere near it. The fetching lives
 * in google.ts and microsoft.ts; the sync that calls both lives in
 * lib/attendance.ts. */

/** One attendee's answer as the provider reports it, before any interpretation.
 *
 * `response` is deliberately the raw string rather than our enum. Mapping it
 * here would mean each provider module owning a copy of the table below, and
 * the first thing to drift would be the value nobody had seen before. */
export type ProviderAttendance = {
  email: string;
  response: string | undefined;
};

/** Mirrors the `attendee_response_status` enum in db/schema.ts. */
export type AttendeeResponse = "noreply" | "yes" | "no" | "maybe";

// Keys are lowercased at lookup, so `needsAction` and `needsaction` both land.
// Providers have been consistent about casing so far; this costs nothing and
// removes a way for a silent no-match to happen.
const GOOGLE: Record<string, AttendeeResponse> = {
  accepted: "yes",
  declined: "no",
  tentative: "maybe",
  needsaction: "noreply",
};

const MICROSOFT: Record<string, AttendeeResponse> = {
  accepted: "yes",
  // Graph reports the mailbox owner as `organizer` rather than `accepted`. They
  // are hosting it, so they are going — reading it as "no answer" would put the
  // session lead in the same bucket as a guest who hasn't opened the invite.
  organizer: "yes",
  declined: "no",
  tentativelyaccepted: "maybe",
  none: "noreply",
  notresponded: "noreply",
};

/** What to store for one attendee, or null for "don't touch the row".
 *
 * Null rather than a default is the whole point. A value we don't recognise
 * means the provider has told us something this code was not written to
 * understand, and the safe reading of that is "no new information" — not
 * "hasn't replied". Writing `noreply` on a shrug would silently erase a real
 * acceptance the last run had read correctly, which is the one failure that
 * makes this feature worse than not having it. */
// Spelled out rather than imported as CalendarProvider from ./index: that
// module imports google.ts and microsoft.ts, which import this one, and a
// type-only edge in a cycle is a thing to explain rather than to leave for
// someone to trip over. The two are structurally identical.
export function toResponseStatus(
  provider: "google" | "microsoft",
  raw: string | undefined
): AttendeeResponse | null {
  if (!raw) return null;
  const table = provider === "microsoft" ? MICROSOFT : GOOGLE;
  return table[raw.trim().toLowerCase()] ?? null;
}
