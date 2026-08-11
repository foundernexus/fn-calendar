/** Same group of members + same time slot = always a duplicate, regardless of
 * organizer (confirmed product decision — organizer is intentionally excluded
 * from the hash). SHA-256 over sorted member IDs + start + duration. */
export async function computeIdempotencyKey(params: {
  memberIds: number[];
  startsAtUnix: number;
  durationMinutes: number;
}) {
  const sorted = [...params.memberIds].sort((a, b) => a - b);
  const raw = `${sorted.join(",")}|${params.startsAtUnix}|${params.durationMinutes}`;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
