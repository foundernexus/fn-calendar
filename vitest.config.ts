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
    testTimeout: 20_000,
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
    },
  },
});
