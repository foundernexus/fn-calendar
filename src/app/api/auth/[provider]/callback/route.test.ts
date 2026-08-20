import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, reinstallTestDb, type TestDb } from "@/test/db";
import { connectState, seedMember, mockCookies, OWNER_EMAIL } from "@/test/helpers";
import { calendarConnections } from "@/db/schema";
import { ADMIN_COOKIE_NAME, MEMBER_COOKIE_NAME } from "@/lib/auth/session";
import { decryptToken } from "@/lib/calendar/crypto";

/** The direct-provider callback. Every guard here was ported from the Nylas
 * version, where each one exists because of something that went wrong or nearly
 * did — so each is proven again rather than assumed to have survived the port. */

let harness: TestDb;

/** Whatever the OAuth round trip resolved to. Set per test. */
let exchanged: {
  email: string;
  refreshToken?: string;
  accessToken: string;
  expiresAt: Date;
  provider: string;
};

vi.mock("@/lib/calendar", async () => {
  const actual = await vi.importActual<typeof import("@/lib/calendar")>("@/lib/calendar");
  return {
    ...actual,
    exchangeCode: vi.fn(async () => ({ ...exchanged })),
  };
});

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
  exchanged = {
    email: "",
    refreshToken: "refresh-token",
    accessToken: "access-token",
    expiresAt: new Date(Date.now() + 3_600_000),
    provider: "google",
  };
});

async function callCallback(state: string, provider = "google") {
  const { GET } = await import("./route");
  return GET(
    new Request(`http://localhost/api/auth/${provider}/callback?code=any-code&state=${state}`),
    { params: Promise.resolve({ provider }) }
  );
}

function statusOf(res: Response) {
  return new URL(res.headers.get("location")!).searchParams.get("status");
}
function destinationOf(res: Response) {
  return new URL(res.headers.get("location")!).pathname;
}

describe("identity", () => {
  it("refuses when the signed-in account is not the member being bound", async () => {
    const victim = await seedMember({ email: "victim@foundernexus.com" });
    exchanged.email = "attacker@evil.com";

    const res = await callCallback(await connectState({ memberId: victim.id }));

    // THE takeover. The sign-in route is public and takes a bare email, so
    // anyone who knows a registered address can reach this point carrying that
    // member's id. Without this guard they'd get a session as the victim and
    // the victim's invites would start arriving in their inbox.
    expect(statusOf(res)).toBe("denied");
    expect(await harness.db.select().from(calendarConnections)).toHaveLength(0);
    expect(res.headers.get("set-cookie") ?? "").not.toContain(MEMBER_COOKIE_NAME);
  });

  it("accepts the member's own registered address", async () => {
    const member = await seedMember({ email: "real@foundernexus.com" });
    exchanged.email = "real@foundernexus.com";

    const res = await callCallback(await connectState({ memberId: member.id }));

    expect(destinationOf(res)).toBe("/me");
    expect(res.headers.get("set-cookie") ?? "").toContain(MEMBER_COOKIE_NAME);
  });

  it("allows a different address once it's already linked to that member", async () => {
    // A personal Gmail against a work address is legitimate — but only after
    // the first binding proved ownership of the registered address.
    const member = await seedMember({ email: "work@foundernexus.com" });
    exchanged.email = "personal@gmail.com";
    await harness.db.insert(calendarConnections).values({
      memberId: member.id,
      provider: "google",
      grantEmail: "personal@gmail.com",
      refreshTokenEncrypted: null,
    });

    const res = await callCallback(await connectState({ memberId: member.id }));
    expect(destinationOf(res)).toBe("/me");
  });

  it("allows a brand-new address only when adding a calendar", async () => {
    // addCalendar can only exist in a token minted behind a proven session, so
    // the public sign-in path can't reach this branch.
    const member = await seedMember({ email: "work@foundernexus.com" });
    exchanged.email = "brand-new@gmail.com";

    const res = await callCallback(
      await connectState({ memberId: member.id, addCalendar: true })
    );
    expect(destinationOf(res)).toBe("/me");
  });
});

describe("tokens", () => {
  it("stores the refresh token encrypted, never in the clear", async () => {
    const member = await seedMember({ email: "m@foundernexus.com" });
    exchanged.email = "m@foundernexus.com";
    exchanged.refreshToken = "super-secret-refresh";

    await callCallback(await connectState({ memberId: member.id }));

    const [row] = await harness.db.select().from(calendarConnections);
    expect(row.refreshTokenEncrypted).not.toContain("super-secret-refresh");
    expect(decryptToken(row.refreshTokenEncrypted!)).toBe("super-secret-refresh");
  });

  it("refuses to save a connection with no refresh token", async () => {
    // Google issues one only on a first authorisation. A row without it looks
    // connected, works for an hour, then goes quiet with nothing to explain it.
    const member = await seedMember({ email: "m@foundernexus.com" });
    exchanged.email = "m@foundernexus.com";
    exchanged.refreshToken = undefined;

    const res = await callCallback(await connectState({ memberId: member.id }));

    expect(statusOf(res)).toBe("provider");
    expect(await harness.db.select().from(calendarConnections)).toHaveLength(0);
  });
});

describe("a calendar someone else already holds", () => {
  it("refuses to take it when adding a second calendar", async () => {
    const owner = await seedMember({ email: "owner@foundernexus.com" });
    const other = await seedMember({ email: "other@foundernexus.com" });
    await harness.db.insert(calendarConnections).values({
      memberId: owner.id,
      provider: "google",
      grantEmail: "shared@gmail.com",
      refreshTokenEncrypted: null,
    });
    exchanged.email = "shared@gmail.com";

    const res = await callCallback(await connectState({ memberId: other.id, addCalendar: true }));

    // Silently reassigning would leave the original owner unbookable with
    // nothing on screen to explain it.
    expect(statusOf(res)).toBe("taken");
    const [row] = await harness.db.select().from(calendarConnections);
    expect(row.memberId).toBe(owner.id);
  });

  it("refuses across providers — one mailbox is one person", async () => {
    // The address is held by someone else under GOOGLE; this is a MICROSOFT
    // sign-in for the same address. Matching on provider too let both stand,
    // and the People page then showed a Team member's address in the Founders
    // list, because it displays whichever address receives invites.
    const owner = await seedMember({ email: "owner@foundernexus.com" });
    const other = await seedMember({ email: "other@foundernexus.com" });
    await harness.db.insert(calendarConnections).values({
      memberId: owner.id,
      provider: "google",
      grantEmail: "shared@foundernexus.com",
      refreshTokenEncrypted: null,
    });
    exchanged.email = "shared@foundernexus.com";
    exchanged.provider = "microsoft";

    const res = await callCallback(
      await connectState({ memberId: other.id, addCalendar: true }),
      "microsoft"
    );

    expect(statusOf(res)).toBe("taken");
    const rows = await harness.db.select().from(calendarConnections);
    expect(rows.every((r) => r.memberId === owner.id)).toBe(true);
  });

  it("moves every row for the address when they sign in, not just this provider's", async () => {
    // Leaving the Microsoft row behind would keep the old member's People entry
    // showing an address that is no longer theirs.
    const previous = await seedMember({ email: "previous@foundernexus.com" });
    const real = await seedMember({ email: "shared@foundernexus.com" });
    await harness.db.insert(calendarConnections).values([
      {
        memberId: previous.id,
        provider: "google",
        grantEmail: "shared@foundernexus.com",
        refreshTokenEncrypted: null,
      },
      {
        memberId: previous.id,
        provider: "microsoft",
        grantEmail: "shared@foundernexus.com",
        refreshTokenEncrypted: null,
      },
    ]);
    exchanged.email = "shared@foundernexus.com";

    await callCallback(await connectState({ memberId: real.id }));

    const rows = await harness.db.select().from(calendarConnections);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.memberId === real.id)).toBe(true);
  });

  it("reassigns it when they sign in with it", async () => {
    // Signing in proves ownership, so whoever held it before was wrong.
    const previous = await seedMember({ email: "previous@foundernexus.com" });
    const real = await seedMember({ email: "shared@gmail.com" });
    await harness.db.insert(calendarConnections).values({
      memberId: previous.id,
      provider: "google",
      grantEmail: "shared@gmail.com",
      refreshTokenEncrypted: null,
    });
    exchanged.email = "shared@gmail.com";

    await callCallback(await connectState({ memberId: real.id }));

    const rows = await harness.db.select().from(calendarConnections);
    expect(rows).toHaveLength(1);
    expect(rows[0].memberId).toBe(real.id);
  });
});

describe("admin sign-in", () => {
  it("mints an admin session for an allowlisted registered address", async () => {
    const admin = await seedMember({ email: OWNER_EMAIL });
    exchanged.email = OWNER_EMAIL;

    const res = await callCallback(
      await connectState({ memberId: admin.id, redirectTo: "admin" })
    );

    expect(destinationOf(res)).toBe("/admin/find-a-time");
    expect(res.headers.get("set-cookie") ?? "").toContain(ADMIN_COOKIE_NAME);
  });

  it("refuses an admin session for someone not on the allowlist", async () => {
    const member = await seedMember({ email: "nobody@foundernexus.com" });
    exchanged.email = "nobody@foundernexus.com";

    const res = await callCallback(
      await connectState({ memberId: member.id, redirectTo: "admin" })
    );

    expect(statusOf(res)).toBe("denied");
    expect(res.headers.get("set-cookie") ?? "").not.toContain(ADMIN_COOKIE_NAME);
  });
});

describe("which calendar receives sessions", () => {
  it("pins the first calendar connected", async () => {
    const member = await seedMember({ email: "m@foundernexus.com" });
    exchanged.email = "m@foundernexus.com";

    await callCallback(await connectState({ memberId: member.id }));

    const [row] = await harness.db.select().from(calendarConnections);
    expect(row.isPrimary).toBe(true);
  });

  it("leaves an existing target alone when a second calendar arrives", async () => {
    // Adding a calendar must not quietly move where your meetings land.
    const member = await seedMember({ email: "m@foundernexus.com" });
    const [first] = await harness.db
      .insert(calendarConnections)
      .values({
        memberId: member.id,
        provider: "google",
        grantEmail: "m@foundernexus.com",
        refreshTokenEncrypted: null,
        isPrimary: true,
      })
      .returning();
    exchanged.email = "second@gmail.com";

    await callCallback(await connectState({ memberId: member.id, addCalendar: true }));

    const rows = await harness.db.select().from(calendarConnections);
    expect(rows.filter((r) => r.isPrimary)).toHaveLength(1);
    expect(rows.find((r) => r.isPrimary)!.id).toBe(first.id);
  });
});

describe("routing", () => {
  it("sends an advisor to their own panel", async () => {
    const advisor = await seedMember({ email: "a@foundernexus.com", isAdvisor: true });
    exchanged.email = "a@foundernexus.com";

    const res = await callCallback(await connectState({ memberId: advisor.id }));
    expect(destinationOf(res)).toBe("/advisor");
  });

  it("rejects an unknown provider in the URL", async () => {
    const member = await seedMember({ email: "m@foundernexus.com" });
    const res = await callCallback(await connectState({ memberId: member.id }), "yahoo");
    expect(statusOf(res)).toBe("expired");
  });

  it("treats a cancelled consent as denied, not as a configuration fault", async () => {
    // "They clicked Cancel" must not read like a broken deployment.
    const member = await seedMember({ email: "m@foundernexus.com" });
    const { GET } = await import("./route");
    const state = await connectState({ memberId: member.id });
    const res = await GET(
      new Request(
        `http://localhost/api/auth/google/callback?error=access_denied&state=${state}`
      ),
      { params: Promise.resolve({ provider: "google" }) }
    );
    expect(statusOf(res)).toBe("denied");
  });
});
