import { z } from "zod";

// Deliberately not `.min(1)` etc: these vars are blank until Neon/Nylas keys are
// pasted in, and this module gets imported by code that Next.js may still touch
// during `next build`'s static analysis before any real deployment. Requiring
// non-empty values here would break the build before credentials exist. Actual
// callers (the Nylas/DB clients) fail loudly at request time if a value is blank —
// this schema's job is just to catch a var being entirely missing from the
// environment (a typo'd or deleted key), not to enforce it's non-empty.
const envSchema = z.object({
  DATABASE_URL: z.string(),
  NYLAS_API_KEY: z.string(),
  NYLAS_CLIENT_ID: z.string(),
  NYLAS_API_URI: z.string(),
  NYLAS_CALLBACK_URI: z.string(),
  ADMIN_EMAILS: z.string(),
  APP_URL: z.string(),
  SESSION_SECRET: z.string(),
});

export const env = envSchema.parse(process.env);
