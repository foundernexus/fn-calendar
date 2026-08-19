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

/** Test-only seam: points every `db` consumer at an in-process Postgres.
 *
 * Route handlers can then be exercised against real tables, real constraints
 * and real transactions without knowing they're in a test — which is the point,
 * since the bugs worth catching here live in exactly those three things (see
 * src/test/db.ts).
 *
 * Never called outside tests. It's a plain setter rather than dependency
 * injection through every call site because the alternative was threading a db
 * argument through forty functions to make one file testable. */
export function __setTestDb(instance: NeonHttpDatabase<typeof schema>) {
  _db = instance;
}

export const db = new Proxy({} as NeonHttpDatabase<typeof schema>, {
  get(_target, prop, receiver) {
    return Reflect.get(getDb(), prop, receiver);
  },
});
