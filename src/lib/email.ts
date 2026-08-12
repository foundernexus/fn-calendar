import { z } from "zod";

/** Consistent email comparison key — every stored email and every lookup
 * (seed, /connect, /admin login, ADMIN_EMAILS) must go through this so a
 * mixed-case entry never silently fails to match. */
export function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

const emailSchema = z.string().trim().toLowerCase().email();

/** Client-side pre-check for free-typed guest emails, using the exact same
 * zod validator as the server's guestEmails schema (src/app/api/admin/events/
 * route.ts) — a looser hand-rolled regex here previously let addresses pass
 * client-side that the server then rejected, so the admin would only find
 * out an address was bad after searching, opening the dialog, and hitting
 * Create. The server's schema remains the real validation gate; this is
 * purely for earlier, friendlier feedback. */
export function isValidEmail(email: string) {
  return emailSchema.safeParse(email).success;
}
