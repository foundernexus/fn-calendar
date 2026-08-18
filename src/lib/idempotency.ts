/** Same set of guest members + same advisor + same time slot = always a
 * duplicate, regardless of who's leading the session (confirmed product
 * decision — organizer is intentionally excluded from the hash). SHA-256 over
 * sorted guest member IDs + advisor + start + duration.
 *
 * The advisor IS part of the identity: the same founders at the same time with
 * a different advisor is a different session, and leaving them out would make
 * the second booking collide with the first and be rejected as a duplicate.
 *
 * When there's no advisor the key is byte-identical to the pre-advisor format,
 * so existing rows keep matching and behaviour for advisor-less bookings is
 * unchanged. */
export async function computeIdempotencyKey(params: {
  guestMemberIds: number[];
  advisorMemberId?: number | null;
  startsAtUnix: number;
  durationMinutes: number;
}) {
  const sorted = [...params.guestMemberIds].sort((a, b) => a - b);
  const advisorPart = params.advisorMemberId ? `|advisor:${params.advisorMemberId}` : "";
  const raw = `${sorted.join(",")}${advisorPart}|${params.startsAtUnix}|${params.durationMinutes}`;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
