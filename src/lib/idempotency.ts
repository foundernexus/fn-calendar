import { normalizeEmail } from "@/lib/email";

/** Same set of guest emails + same time slot = always a duplicate, regardless
 * of who's leading the session (confirmed product decision — organizer is
 * intentionally excluded from the hash). SHA-256 over sorted guest emails +
 * start + duration. */
export async function computeIdempotencyKey(params: {
  guestEmails: string[];
  startsAtUnix: number;
  durationMinutes: number;
}) {
  const sorted = [...params.guestEmails].map(normalizeEmail).sort();
  const raw = `${sorted.join(",")}|${params.startsAtUnix}|${params.durationMinutes}`;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
