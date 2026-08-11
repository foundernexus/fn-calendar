import { drizzle, type NeonHttpDatabase } from "drizzle-orm/neon-http";
import { neon } from "@neondatabase/serverless";
import { env } from "@/lib/env";
import * as schema from "./schema";

// Lazy: neon() throws immediately if given a blank connection string, and
// DATABASE_URL is blank until the user pastes in their Neon credentials. Building
// the client at module-eval time would crash the moment any route imports this
// file (including during `next build`'s module graph analysis, before any real
// deploy). Deferring construction to first use means the app still builds and
// boots with blank credentials — it only fails, correctly, when a request
// actually needs the database.
let _db: NeonHttpDatabase<typeof schema> | undefined;

function getDb() {
  if (!_db) {
    _db = drizzle(neon(env.DATABASE_URL), { schema });
  }
  return _db;
}

export const db = new Proxy({} as NeonHttpDatabase<typeof schema>, {
  get(_target, prop, receiver) {
    return Reflect.get(getDb(), prop, receiver);
  },
});
