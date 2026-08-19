/** What to do when the server says 401 in the middle of an admin action.
 *
 * An admin session lasts 8 hours, so a tab left open overnight looks perfectly
 * normal the next morning — the page is still rendered, every button is still
 * there — and the first thing clicked fails. Until now the app answered with
 * the bare word "Unauthorized", which is the HTTP status name and not a
 * sentence. It cost real time: adding a colleague as Team failed with
 * "Unauthorized", which reads as "you lack permission for that", when the truth
 * was simply "you are no longer signed in".
 *
 * Redirecting rather than only showing a toast is the point. There is exactly
 * one thing to do about an expired session, so do it, instead of leaving
 * someone to work out that they should reload. The message is carried on the
 * URL because a toast raised immediately before a navigation is never read. */
export function handleExpiredSession(response: Response) {
  if (response.status !== 401) return false;
  window.location.href = "/connect?status=session";
  return true;
}
