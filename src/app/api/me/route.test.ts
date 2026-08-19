import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, reinstallTestDb, type TestDb } from "@/test/db";
import {
  memberCookie,
  jsonRequest,
  mockCookies,
  seedMember,
  seedConnection,
} from "@/test/helpers";
import { members, memberAvailability, calendarConnections } from "@/db/schema";
import { getMemberConnectionState } from "@/db/queries";

/** What a member controls about themselves: when they're available, which
 * calendars are checked, and which one receives sessions. */

let harness: TestDb;

const revokeNylasGrant = vi.fn(async () => ({}));
vi.mock("@/lib/nylas", () => ({
  revokeNylasGrant: () => revokeNylasGrant(),
  buildHostedAuthUrl: () => "https://example.test/auth",
  asCalendarProvider: (v: string) => (v === "microsoft" ? "microsoft" : "google"),
  CALENDAR_PROVIDERS: ["google", "microsoft"],
}));

beforeAll(async () => {
  harness = await createTestDb();
});
afterAll(async () => {
  await harness.close();
});
beforeEach(async () => {
  await harness.reset();
  vi.clearAllMocks();
  revokeNylasGrant.mockResolvedValue({});
  vi.resetModules();
  await reinstallTestDb();
});

async function saveSettings(memberId: number, payload: Record<string, unknown>) {
  mockCookies(await memberCookie(memberId));
  const { PATCH } = await import("./route");
  return PATCH(
    jsonRequest("http://localhost/api/me", payload, {
      cookie: await memberCookie(memberId),
      method: "PATCH",
    })
  );
}

async function calendars(memberId: number, method: "PATCH" | "DELETE", body: unknown) {
  mockCookies(await memberCookie(memberId));
  const mod = await import("./calendars/route");
  const handler = method === "PATCH" ? mod.PATCH : mod.DELETE;
  return handler(
    jsonRequest("http://localhost/api/me/calendars", body, {
      cookie: await memberCookie(memberId),
      method,
    })
  );
}

describe("saving availability", () => {
  it("stores the timezone and the blocks together", async () => {
    const member = await seedMember({ email: "m@example.com" });
    const res = await saveSettings(member.id, {
      timezone: "America/New_York",
      availability: [
        { dayOfWeek: 1, startTime: "09:00", endTime: "12:00" },
        { dayOfWeek: 1, startTime: "14:00", endTime: "17:00" },
      ],
    });
    expect(res.status).toBe(200);

    const [row] = await harness.db.select().from(members).where(eq(members.id, member.id));
    expect(row.timezone).toBe("America/New_York");
    expect(await harness.db.select().from(memberAvailability)).toHaveLength(2);
  });

  it("leaves the timezone unset when the blocks are rejected", async () => {
    const member = await seedMember({ email: "m@example.com" });

    // Overlapping blocks — the server refuses. The timezone must not land on
    // its own: a member with a timezone and no blocks reads as "available
    // never", so a half-applied save would silently remove them from every
    // search while the form reported success.
    const res = await saveSettings(member.id, {
      timezone: "America/New_York",
      availability: [
        { dayOfWeek: 1, startTime: "09:00", endTime: "12:00" },
        { dayOfWeek: 1, startTime: "11:00", endTime: "13:00" },
      ],
    });

    expect(res.status).toBe(400);
    const [row] = await harness.db.select().from(members).where(eq(members.id, member.id));
    expect(row.timezone).toBeNull();
  });

  it("replaces the previous blocks wholesale", async () => {
    const member = await seedMember({ email: "m@example.com" });
    await saveSettings(member.id, {
      timezone: "America/Los_Angeles",
      availability: [{ dayOfWeek: 1, startTime: "09:00", endTime: "17:00" }],
    });
    await saveSettings(member.id, {
      timezone: "America/Los_Angeles",
      availability: [{ dayOfWeek: 2, startTime: "10:00", endTime: "11:00" }],
    });

    const rows = await harness.db.select().from(memberAvailability);
    expect(rows).toHaveLength(1);
    expect(rows[0].dayOfWeek).toBe(2);
  });

  it("accepts every day off", async () => {
    const member = await seedMember({ email: "m@example.com" });
    const res = await saveSettings(member.id, {
      timezone: "America/Los_Angeles",
      availability: [],
    });
    expect(res.status).toBe(200);
    expect(await harness.db.select().from(memberAvailability)).toHaveLength(0);
  });

  it("rejects more than three blocks in one day", async () => {
    const member = await seedMember({ email: "m@example.com" });
    const res = await saveSettings(member.id, {
      timezone: "America/Los_Angeles",
      availability: [
        { dayOfWeek: 1, startTime: "08:00", endTime: "09:00" },
        { dayOfWeek: 1, startTime: "10:00", endTime: "11:00" },
        { dayOfWeek: 1, startTime: "12:00", endTime: "13:00" },
        { dayOfWeek: 1, startTime: "14:00", endTime: "15:00" },
      ],
    });
    expect(res.status).toBe(400);
  });

  it("rejects a save with no session", async () => {
    mockCookies();
    const { PATCH } = await import("./route");
    const res = await PATCH(
      jsonRequest("http://localhost/api/me", { timezone: "America/Los_Angeles", availability: [] }, {
        method: "PATCH",
      })
    );
    expect(res.status).toBe(401);
  });
});

describe("choosing which calendar receives sessions", () => {
  it("moves the marker and clears the old one", async () => {
    const member = await seedMember({ email: "m@example.com" });
    const work = await seedConnection({
      memberId: member.id,
      grantEmail: "work@example.com",
      grantId: "g-w",
      isPrimary: true,
    });
    const personal = await seedConnection({
      memberId: member.id,
      grantEmail: "personal@example.com",
      grantId: "g-p",
    });

    const res = await calendars(member.id, "PATCH", { connectionId: personal.id });
    expect(res.status).toBe(200);

    const rows = await harness.db.select().from(calendarConnections);
    // Exactly one, always. A partial unique index enforces it, so two rows
    // claiming the target would make the receiving calendar depend on row
    // order.
    expect(rows.filter((r) => r.isPrimary)).toHaveLength(1);
    expect(rows.find((r) => r.isPrimary)!.id).toBe(personal.id);
    expect(rows.find((r) => r.id === work.id)!.isPrimary).toBe(false);
  });

  it("refuses to repoint a calendar belonging to someone else", async () => {
    const mine = await seedMember({ email: "mine@example.com" });
    await seedConnection({ memberId: mine.id, grantEmail: "mine@example.com", grantId: "g-m" });
    const theirs = await seedMember({ email: "theirs@example.com" });
    const theirConn = await seedConnection({
      memberId: theirs.id,
      grantEmail: "theirs@example.com",
      grantId: "g-t",
    });

    const res = await calendars(mine.id, "PATCH", { connectionId: theirConn.id });
    expect(res.status).toBe(404);
  });
});

describe("removing one calendar", () => {
  it("revokes it and leaves a target behind", async () => {
    const member = await seedMember({ email: "m@example.com" });
    const work = await seedConnection({
      memberId: member.id,
      grantEmail: "work@example.com",
      grantId: "g-w",
      isPrimary: true,
      connectedAt: new Date("2026-01-01T00:00:00Z"),
    });
    const personal = await seedConnection({
      memberId: member.id,
      grantEmail: "personal@example.com",
      grantId: "g-p",
      connectedAt: new Date("2026-02-01T00:00:00Z"),
    });

    const res = await calendars(member.id, "DELETE", { connectionId: work.id });
    expect(res.status).toBe(200);
    expect(revokeNylasGrant).toHaveBeenCalledTimes(1);

    // The removed one held the marker. Somebody must still receive sessions,
    // or the next booking has nowhere to go.
    const state = await getMemberConnectionState(member.id);
    expect(state.calendars).toHaveLength(1);
    expect(state.calendars[0].id).toBe(personal.id);
    expect(state.connection?.grantEmail).toBe("personal@example.com");
  });

  it("refuses to remove the last one", async () => {
    const member = await seedMember({ email: "m@example.com" });
    const only = await seedConnection({
      memberId: member.id,
      grantEmail: "only@example.com",
      grantId: "g-o",
    });

    // Silently making yourself unbookable from a per-row delete button is not
    // something to allow by accident; "Disconnect all" says what it does.
    const res = await calendars(member.id, "DELETE", { connectionId: only.id });
    expect(res.status).toBe(409);
    expect(revokeNylasGrant).not.toHaveBeenCalled();
  });
});

describe("disconnecting entirely", () => {
  it("revokes every grant and clears the marker", async () => {
    const member = await seedMember({ email: "m@example.com" });
    await seedConnection({
      memberId: member.id,
      grantEmail: "a@example.com",
      grantId: "g-a",
      isPrimary: true,
    });
    await seedConnection({ memberId: member.id, grantEmail: "b@example.com", grantId: "g-b" });

    mockCookies(await memberCookie(member.id));
    const { POST } = await import("./disconnect/route");
    const res = await POST();
    expect(res.status).toBe(200);

    expect(revokeNylasGrant).toHaveBeenCalledTimes(2);
    const rows = await harness.db.select().from(calendarConnections);
    expect(rows.every((r) => r.connectionStatus === "revoked")).toBe(true);
    // A revoked row keeping the marker collides with the partial unique index
    // the next time a calendar is connected, silently breaking the pin.
    expect(rows.every((r) => r.isPrimary === false)).toBe(true);
  });
});

describe("connection state", () => {
  it("counts someone as connected when only one of several rows is usable", async () => {
    const member = await seedMember({ email: "m@example.com" });
    // Same address, rows from a retired app and the current one — exactly what
    // accumulates across a Sandbox-to-production move.
    await seedConnection({
      memberId: member.id,
      grantEmail: "m@example.com",
      grantId: "g-old",
      clientId: "retired-app",
      connectedAt: new Date("2026-03-01T00:00:00Z"),
    });
    await seedConnection({
      memberId: member.id,
      grantEmail: "m@example.com",
      grantId: "g-new",
      connectedAt: new Date("2026-01-01T00:00:00Z"),
    });

    const state = await getMemberConnectionState(member.id);

    // Picking purely by recency would surface the retired row and report a
    // perfectly connected member as disconnected.
    expect(state.needsReconnect).toBe(false);
    expect(state.calendars).toHaveLength(1);
    expect(state.connection).not.toBeNull();
  });

  it("reports needsReconnect only when nothing works", async () => {
    const member = await seedMember({ email: "m@example.com" });
    await seedConnection({
      memberId: member.id,
      grantEmail: "m@example.com",
      grantId: "g-stale",
      clientId: "retired-app",
    });

    const state = await getMemberConnectionState(member.id);
    expect(state.needsReconnect).toBe(true);
    expect(state.calendars).toHaveLength(0);
  });
});
