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
