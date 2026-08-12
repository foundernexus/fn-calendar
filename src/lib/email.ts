/** Consistent email comparison key — every stored email and every lookup
 * (seed, /connect, /admin login, ADMIN_EMAILS) must go through this so a
 * mixed-case entry never silently fails to match. */
export function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}
