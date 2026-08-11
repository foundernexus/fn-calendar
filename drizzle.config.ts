import { config } from "dotenv";
import { defineConfig } from "drizzle-kit";

// drizzle-kit only auto-loads `.env`, not `.env.local` — load it explicitly so
// `db:generate`/`db:migrate`/`db:push` see DATABASE_URL.
config({ path: ".env.local" });

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
});
