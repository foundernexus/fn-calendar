import { hasAdminAccess } from "@/lib/auth/admin";
import type { CalendarAccess } from "@/lib/calendar/scopes";

/** How much calendar access one person needs — the single source of truth.
 *
 * Five places have to agree on this: the four routes that build a consent URL
 * (sign-in, admin connect, add-a-calendar, reconnect) and the callback that
 * checks what came back. If any of them disagreed, someone would be sent to a
 * consent screen asking for one thing and then be refused for granting exactly
 * that — so the rule lives here and nowhere else.
 *
 * Write access follows one question: could a session ever be created on THIS
 * person's calendar? That's true for facilitators, who are the only people the
 * find-a-time form will accept as a session lead, and for admins, who run the
 * sessions. For everyone else the answer is no — they are attendees, invited by
 * email address, which needs no permission from them at all.
 *
 * Deliberately re-read live rather than baked into the state token: someone
 * promoted to facilitator between starting a flow and finishing it should be
 * measured against what they are now. */
export async function calendarAccessFor(member: {
  email: string;
  isFacilitator: boolean;
}): Promise<CalendarAccess> {
  if (member.isFacilitator) return "write";
  return (await hasAdminAccess(member.email)) ? "write" : "read";
}
