import fs from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import type { NeonHttpDatabase } from "drizzle-orm/neon-http";
import * as schema from "@/db/schema";
import { __setTestDb } from "@/db";

/** A real Postgres for the route tests, running in-process.
 *
 * Not a mock, and that distinction is the whole point. Three of the bugs found
 * on 2026-08-18 were invisible to anything that stubs the database out: a
 * UNIQUE constraint that made cancel-then-rebook silently no-op, a missing
 * transaction that let a session save with no attendees, and a driver
 * returning a string where the type claimed Date. A fake database has no
 * constraints, no transactions, and returns whatever the fake was told to.
 *
 * PGlite runs the project's own migration files, so the schema under test is
 * byte-for-byte the schema in production — enums, partial indexes, cascade
 * rules and all.
 *
 * It also needs no credentials and no network, which rules out the failure
 * mode that would matter most here: a test suite that truncates tables while
 * pointed at the production database. There is nothing to misconfigure.
 */

const MIGRATIONS_DIR = path.resolve(process.cwd(), "drizzle");

/** drizzle-kit writes several statements per file, separated by this marker. */
const STATEMENT_SEPARATOR = "--> statement-breakpoint";

export type TestDb = Awaited<ReturnType<typeof createTestDb>>;

let installed: NeonHttpDatabase<typeof schema> | undefined;

/** Re-points a freshly-reloaded `@/db` at the test database.
 *
 * Route tests call vi.resetModules() between cases so each one gets clean
 * module state and its own next/headers stub. That hands back a brand new
 * copy of @/db with nothing injected, which then builds the real neon client
 * and tries to reach the network. Call this after every reset — before the
 * route module is imported. */
export async function reinstallTestDb() {
  if (!installed) throw new Error("createTestDb() must run first");
  const { __setTestDb } = await import("@/db");
  __setTestDb(installed);
}

export async function createTestDb() {
  const client = new PGlite();
  const base = drizzle(client, { schema });

  for (const file of fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort()) {
    const body = fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
    for (const statement of body.split(STATEMENT_SEPARATOR)) {
      const trimmed = statement.trim();
      if (trimmed) await client.exec(trimmed);
    }
  }

  // `db.batch()` belongs to the neon-http driver and the app uses it in seven
  // places — every one of them a transaction worth verifying. PGlite has no
  // batch, so it's supplied here.
  //
  // This is a REAL transaction, not a pretend one: PGlite is a single
  // in-process connection, so BEGIN and COMMIT issued on that client wrap
  // whatever runs between them. Constraint violations abort, and ROLLBACK
  // genuinely undoes the earlier statements — which is exactly the behaviour
  // the tests are asserting.
  //
  // The one difference from production: neon sends a batch as a single round
  // trip, this issues them in sequence. Nothing about atomicity or constraint
  // behaviour differs, which is all these tests examine.
  const db = new Proxy(base, {
    get(target, prop, receiver) {
      if (prop === "batch") {
        return async (queries: readonly PromiseLike<unknown>[]) => {
          await client.query("BEGIN");
          try {
            const results: unknown[] = [];
            for (const query of queries) results.push(await query);
            await client.query("COMMIT");
            return results;
          } catch (err) {
            await client.query("ROLLBACK");
            throw err;
          }
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });

  // Point the app's own `db` export at this instance, so route handlers under
  // test hit it without knowing they're in a test.
  __setTestDb(db as unknown as NeonHttpDatabase<typeof schema>);
  installed = db as unknown as NeonHttpDatabase<typeof schema>;

  return {
    db: db as unknown as NeonHttpDatabase<typeof schema>,
    client,
    /** Empties every table between tests. Truncate rather than drop-and-migrate
     * — three orders of magnitude faster, and RESTART IDENTITY keeps ids
     * predictable so a test can assert on member 1 rather than whatever the
     * sequence happens to be at. */
    async reset() {
      await client.exec(`
        TRUNCATE TABLE event_attendees, events, member_availability, calendar_connections, members
        RESTART IDENTITY CASCADE
      `);
    },
    async close() {
      await client.close();
    },
  };
}
