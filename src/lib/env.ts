import { z } from "zod";

// Deliberately not `.min(1)` etc on most of these: these vars are blank until
// Neon/Nylas keys are pasted in, and this module gets imported by code that
// Next.js may still touch during `next build`'s static analysis before any
// real deployment. Requiring non-empty values here would break the build
// before credentials exist. Actual callers (the Nylas/DB clients) fail
// loudly at request time if a value is blank — this schema's job is just to
// catch a var being entirely missing from the environment (a typo'd or
// deleted key), not to enforce it's non-empty. SESSION_SECRET is the one
// deliberate exception — see below.
const envSchema = z.object({
  DATABASE_URL: z.string(),
  NYLAS_API_KEY: z.string(),
  NYLAS_CLIENT_ID: z.string(),
  NYLAS_API_URI: z.string(),
  NYLAS_CALLBACK_URI: z.string(),
  ADMIN_EMAILS: z.string(),
  APP_URL: z.string(),
  // Talking to Google and Microsoft directly instead of through Nylas. These
  // carry `.default("")` rather than following the plain `z.string()` rule
  // above ONLY while the switch is in progress: nothing reads them yet, and a
  // missing key would otherwise break local dev and CI before the values exist
  // everywhere. Drop the defaults in the cutover commit, once the Nylas vars
  // come out — at that point a blank value here means nobody can sign in, and
  // that should fail loudly at boot rather than at 3pm on a Tuesday.
  GOOGLE_CLIENT_ID: z.string().default(""),
  GOOGLE_CLIENT_SECRET: z.string().default(""),
  MICROSOFT_CLIENT_ID: z.string().default(""),
  MICROSOFT_CLIENT_SECRET: z.string().default(""),
  /** "common" admits both work and personal Microsoft accounts, matching how
   * the Azure app registration is configured. A tenant GUID here would lock
   * out every founder using a personal Outlook address. */
  MICROSOFT_TENANT: z.string().default("common"),
  // Every session/state token in the app (admin, member, OAuth state) is
  // HMAC-signed with this one value — unlike the other vars above, a blank
  // or weak value here isn't just "not configured yet," it's a live security
  // hole (trivially forgeable tokens, including admin sessions), so this one
  // DOES enforce a minimum rather than just checking it's present.
  SESSION_SECRET: z.string().min(32),
});

export const env = envSchema.parse(process.env);
