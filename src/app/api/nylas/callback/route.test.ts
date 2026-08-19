import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, reinstallTestDb, type TestDb } from "@/test/db";
import {
  connectState,
  seedMember,
  seedConnection,
  mockCookies,
  TEST_CLIENT_ID,
  OWNER_EMAIL,
} from "@/test/helpers";
import { calendarConnections } from "@/db/schema";
import {
  ADMIN_COOKIE_NAME,
  MEMBER_COOKIE_NAME,
} from "@/lib/auth/session";

/** The one place a stranger could have walked in as somebody else, and the
 * file that changed most on 2026-08-18. Every test here is a bug that shipped
 * or nearly shipped that day. */

let harness: TestDb;

/** Whatever Nylas says the OAuth round trip resolved to. Set per test. */
const exchanged = { grantId: "", email: "", provider: "google" };

vi.mock("@/lib/nylas", () => ({
  exchangeNylasCode: vi.fn(async () => ({ ...exchanged })),
  CALENDAR_PROVIDERS: ["google", "microsoft"],
  asCalendarProvider: (v: string) => (v === "microsoft" ? "microsoft" : "google"),
  buildHostedAuthUrl: () => "https://example.test/auth",
}));

beforeAll(async () => {
  harness = await createTestDb();
});
afterAll(async () => {
  await harness.close();
});
beforeEach(async () => {
  await harness.reset();
  vi.resetModules();
  mockCookies();
  await reinstallTestDb();
});

async function callCallback(state: string, code = "any-code") {
  const { GET } = await import("./route");
  return GET(new Request(`http://localhost/api/nylas/callback?code=${code}&state=${state}`));
}

function statusOf(res: Response) {
  return new URL(res.headers.get("location")!).searchParams.get("status");
}

describe("identity", () => {
  it("refuses when the signed-in account is not the member being bound", async () => {
    const victim = await seedMember({ email: "victim@foundernexus.com" });
    Object.assign(exchanged, { grantId: "attacker-grant", email: "attacker@evil.com" });

    const res = await callCallback(await connectState({ memberId: victim.id }));

    // THE takeover. /api/connect/start is public and takes a bare email, so
    // anyone who knew a registered address could reach this point carrying
    // that member's id. Before the fix this returned a session as the victim
    // and rewrote their calendar connection, sending their future invites to
    // the attacker.
    expect(statusOf(res)).toBe("denied");
    const rows = await harness.db.select().from(calendarConnections);
    expect(rows).toHaveLength(0);
    expect(res.headers.get("set-cookie") ?? "").not.toContain(MEMBER_COOKIE_NAME);
  });

  it("accepts the member's own registered address", async () => {
    const member = await seedMember({ email: "real@foundernexus.com" });
    Object.assign(exchanged, { grantId: "g1", email: "real@foundernexus.com" });

    const res = await callCallback(await connectState({ memberId: member.id }));

    expect(statusOf(res)).toBeNull();
    const [row] = await harness.db.select().from(calendarConnections);
    expect(row.memberId).toBe(member.id);
  });

  it("accepts a different address that is already linked to that member", async () => {
    // The case that made a strict equality check the wrong fix: someone
    // registered under a work address whose calendar lives on a personal one.
    const member = await seedMember({ email: "mckinney-3@hotmail.com" });
    await seedConnection({
      memberId: member.id,
      grantEmail: "mtmckinney@outlook.com",
      grantId: "g-existing",
    });
    Object.assign(exchanged, { grantId: "g-existing", email: "mtmckinney@outlook.com" });

    const res = await callCallback(await connectState({ memberId: member.id }));
    expect(statusOf(res)).toBeNull();
  });

  it("accepts a brand new address only when the flow came from a member session", async () => {
    const member = await seedMember({ email: "court@foundernexus.com" });
    await seedConnection({ memberId: member.id, grantEmail: "court@foundernexus.com" });
    Object.assign(exchanged, { grantId: "g-personal", email: "court.private@gmail.com" });

    // Without the flag this is indistinguishable from the takeover above.
    const denied = await callCallback(await connectState({ memberId: member.id }));
    expect(statusOf(denied)).toBe("denied");

    // With it — mintable only behind requireMemberSession — it's someone
    // adding their own second calendar.
    const allowed = await callCallback(
      await connectState({ memberId: member.id, addCalendar: true })
    );
    expect(statusOf(allowed)).toBeNull();
    expect(await harness.db.select().from(calendarConnections)).toHaveLength(2);
  });
});

describe("admin sessions", () => {
  it("grants admin only to someone on the allowlist", async () => {
    const member = await seedMember({ email: OWNER_EMAIL });
    Object.assign(exchanged, { grantId: "g-admin", email: OWNER_EMAIL });

    const res = await callCallback(await connectState({ memberId: member.id, redirectTo: "admin" }));
    expect(res.headers.get("set-cookie")).toContain(ADMIN_COOKIE_NAME);
  });

  it("refuses admin to a member who merely asked for it", async () => {
    const member = await seedMember({ email: "founder@example.com" });
    Object.assign(exchanged, { grantId: "g-f", email: "founder@example.com" });

    const res = await callCallback(await connectState({ memberId: member.id, redirectTo: "admin" }));
    expect(statusOf(res)).toBe("denied");
  });
});

describe("which calendar receives sessions", () => {
  it("pins the first calendar connected", async () => {
    const member = await seedMember({ email: "solo@example.com" });
    Object.assign(exchanged, { grantId: "g-first", email: "solo@example.com" });

    await callCallback(await connectState({ memberId: member.id }));

    const [row] = await harness.db.select().from(calendarConnections);
    expect(row.isPrimary).toBe(true);
  });

  it("does NOT move the target when a second calendar is added", async () => {
    // Shipped broken: the fallback picked the most recently connected, so
    // adding a calendar silently redirected every future invite onto it.
    const member = await seedMember({ email: "work@example.com" });
    const first = await seedConnection({
      memberId: member.id,
      grantEmail: "work@example.com",
      grantId: "g-work",
      isPrimary: true,
      connectedAt: new Date("2026-01-01T00:00:00Z"),
    });
    Object.assign(exchanged, { grantId: "g-private", email: "private@gmail.com" });

    await callCallback(await connectState({ memberId: member.id, addCalendar: true }));

    const rows = await harness.db.select().from(calendarConnections);
    expect(rows.find((r) => r.isPrimary)!.id).toBe(first.id);
  });

  it("refuses a calendar that already belongs to someone else", async () => {
    const owner = await seedMember({ email: "owner@example.com" });
    await seedConnection({ memberId: owner.id, grantEmail: "shared@example.com", grantId: "g-shared" });
    const other = await seedMember({ email: "other@example.com" });
    await seedConnection({ memberId: other.id, grantEmail: "other@example.com" });
    Object.assign(exchanged, { grantId: "g-shared", email: "shared@example.com" });

    const res = await callCallback(await connectState({ memberId: other.id, addCalendar: true }));

    // Attaching it would have stripped the first member of their connection,
    // leaving them unbookable with nothing on screen to explain it.
    expect(statusOf(res)).toBe("taken");
    const [row] = await harness.db
      .select()
      .from(calendarConnections)
      .where(eq(calendarConnections.nylasGrantId, "g-shared"));
    expect(row.memberId).toBe(owner.id);
  });

  it("reconnecting the same calendar updates the row rather than adding one", async () => {
    const member = await seedMember({ email: "again@example.com" });
    await seedConnection({
      memberId: member.id,
      grantEmail: "again@example.com",
      grantId: "g-same",
      status: "revoked",
    });
    Object.assign(exchanged, { grantId: "g-same", email: "again@example.com" });

    await callCallback(await connectState({ memberId: member.id }));

    const rows = await harness.db.select().from(calendarConnections);
    expect(rows).toHaveLength(1);
    expect(rows[0].connectionStatus).toBe("connected");
  });
});

describe("bad input", () => {
  it("rejects a tampered state token", async () => {
    const res = await callCallback("not-a-real-token");
    expect(statusOf(res)).toBe("expired");
  });

  it("rejects a state token naming a member who no longer exists", async () => {
    const res = await callCallback(await connectState({ memberId: 9999 }));
    expect(statusOf(res)).toBe("denied");
  });

  it("stores the client id, so a later app switch marks the row unusable", async () => {
    const member = await seedMember({ email: "c@example.com" });
    Object.assign(exchanged, { grantId: "g-c", email: "c@example.com" });
    await callCallback(await connectState({ memberId: member.id }));
    const [row] = await harness.db.select().from(calendarConnections);
    expect(row.nylasClientId).toBe(TEST_CLIENT_ID);
  });
});
