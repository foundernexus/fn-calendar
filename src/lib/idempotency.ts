/** Same set of guest members + same time slot = always a duplicate, regardless
 * of who's leading the session (confirmed product decision — organizer is
 * intentionally excluded from the hash). SHA-256 over sorted guest member IDs
 * + start + duration. */
export async function computeIdempotencyKey(params: {
  guestMemberIds: number[];
  startsAtUnix: number;
  durationMinutes: number;
}) {
  const sorted = [...params.guestMemberIds].sort((a, b) => a - b);
  const raw = `${sorted.join(",")}|${params.startsAtUnix}|${params.durationMinutes}`;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
