import { sql } from "drizzle-orm";
import { db } from "./index";
import { calendarConnections } from "./schema";

export type LatestConnectionRow = {
  id: number;
  member_id: number;
  nylas_grant_id: string;
  provider: string;
  grant_email: string;
  connection_status: "connected" | "revoked";
  connected_at: Date;
  revoked_at: Date | null;
};

/**
 * The latest connection row per member (a member can reconnect and produce
 * multiple `calendar_connections` rows over time — this resolves to the most
 * recent one, connected OR revoked). Optionally scoped to a set of member IDs.
 * Callers that need to know if a member can actually be scheduled should use
 * `getActiveConnections` instead — this one intentionally includes revoked rows.
 */
export async function getLatestConnections(memberIds?: number[]) {
  const memberFilter =
    memberIds && memberIds.length > 0
      ? sql`WHERE member_id IN (${sql.join(
          memberIds.map((id) => sql`${id}`),
          sql`, `
        )})`
      : sql``;

  const result = await db.execute<LatestConnectionRow>(sql`
    SELECT DISTINCT ON (member_id) *
    FROM ${calendarConnections}
    ${memberFilter}
    ORDER BY member_id, connected_at DESC, id DESC
  `);

  return result.rows;
}

/** Same as `getLatestConnections`, filtered to members whose latest connection is
 * actually usable — i.e. connection_status = 'connected', not revoked. */
export async function getActiveConnections(memberIds?: number[]) {
  const rows = await getLatestConnections(memberIds);
  return rows.filter((row) => row.connection_status === "connected");
}
