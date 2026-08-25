import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // Route tests each boot their own in-process Postgres and apply every
    // migration. That's a couple of seconds of WASM startup, and the default
    // 10s hook budget is not enough once several files do it at once.
    hookTimeout: 60_000,
    // The booking tests reach the real Nylas host and get a fast 401 from the
    // stub key below — except when they don't. One run in three, that request
    // sat for 15 seconds and the test blew a 20s budget, so D10 and D15 failed
    // on network weather rather than on anything in the code. A suite that
    // fails at random is a suite people stop reading.
    testTimeout: 45_000,
    // One file at a time. Several PGlite instances competing for memory made
    // startup slower than running them in sequence, and a timeout that only
    // appears under parallel load is the kind of flake that erodes trust in a
    // suite until people stop reading it.
    fileParallelism: false,
    // Stub values so importing modules that pull in src/lib/env.ts (which
    // parses process.env at module load) doesn't fail in a clean checkout
    // with no .env.local — tests should never depend on real credentials.
    env: {
      DATABASE_URL: "postgresql://test:test@localhost:5432/test",
      NYLAS_API_KEY: "test-nylas-api-key",
      NYLAS_CLIENT_ID: "test-nylas-client-id",
      NYLAS_API_URI: "https://api.us.nylas.com",
      NYLAS_CALLBACK_URI: "http://localhost:3000/api/nylas/callback",
      ADMIN_EMAILS: "tobias@foundernexus.com,karink@foundernexus.com",
      APP_URL: "http://localhost:3000",
      SESSION_SECRET: "test-secret-at-least-32-characters-long",
      // Empty on purpose, and load-bearing. The booking tests book and cancel
      // real sessions, and each of those now pushes a member's 1:1 dates to
      // HubSpot. A token here would point at the live CRM, so a test run would
      // rewrite real people's records against a throwaway database.
      HUBSPOT_TOKEN: "",
    },
  },
});
