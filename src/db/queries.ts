import { eq, inArray, sql } from "drizzle-orm";
import { db } from "./index";
import { calendarConnections, members } from "./schema";
import { normalizeEmail } from "@/lib/email";

/** Case-insensitive member lookup — always goes through normalizeEmail so a
 * mixed-case input never silently misses a stored row. */
export async function getMemberByEmail(email: string) {
  const rows = await db
    .select()
    .from(members)
    .where(eq(members.email, normalizeEmail(email)))
    .limit(1);
  return rows[0] ?? null;
}

export async function getMemberById(id: number) {
  const rows = await db.select().from(members).where(eq(members.id, id)).limit(1);
  return rows[0] ?? null;
}

/** Batch member lookup — one query instead of N. */
export async function getMembersByIds(ids: number[]) {
  if (ids.length === 0) return [];
  return db.select().from(members).where(inArray(members.id, ids));
}

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
  // `undefined` means "no filter, every member"; `[]` means "filter to
  // nothing" — those are different requests and must not both fall through
  // to the same unfiltered query.
  if (memberIds && memberIds.length === 0) return [];

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

export type MemberWithConnection = {
  id: number;
  email: string;
  fullName: string;
  connected: boolean;
  provider: string | null;
  grantEmail: string | null;
};

/** Every member, each annotated with whether their latest connection is
 * currently active — for the admin find-a-time multi-select's connected/not
 * connected badges. */
export async function getMembersWithConnectionStatus(): Promise<MemberWithConnection[]> {
  const allMembers = await db.select().from(members).orderBy(members.fullName);
  const active = await getActiveConnections(allMembers.map((m) => m.id));
  const activeByMember = new Map(active.map((row) => [row.member_id, row]));

  return allMembers.map((m) => {
    const connection = activeByMember.get(m.id);
    return {
      id: m.id,
      email: m.email,
      fullName: m.fullName,
      connected: !!connection,
      provider: connection?.provider ?? null,
      grantEmail: connection?.grant_email ?? null,
    };
  });
}
