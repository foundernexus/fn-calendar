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
  grantedScopes?: string[];
};

/** A grant with every permission we ever ask for, across both providers, so the
 * tests that aren't about scopes are unaffected by which provider they use. */
const FULL_GRANT = [
  "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
  "https://www.googleapis.com/auth/calendar.freebusy",
  "https://www.googleapis.com/auth/calendar.events",
  "Calendars.ReadWrite",
];

/** Set to make the code exchange fail instead of resolving. */
let exchangeError: Error | null = null;

vi.mock("@/lib/calendar", async () => {
  const actual = await vi.importActual<typeof import("@/lib/calendar")>("@/lib/calendar");
  return {
    ...actual,
    exchangeCode: vi.fn(async () => {
      if (exchangeError) throw exchangeError;
      return { ...exchanged };
    }),
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
  exchangeError = null;
  exchanged = {
    email: "",
    refreshToken: "refresh-token",
    accessToken: "access-token",
    expiresAt: new Date(Date.now() + 3_600_000),
    provider: "google",
    grantedScopes: [...FULL_GRANT],
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

describe("a code that was already used", () => {
  it("says so instead of blaming our configuration", async () => {
    // A code redeems once. Reaching the exchange with invalid_grant therefore
    // means this callback URL was opened twice — a reload, the back button, a
    // double click on the unverified-app interstitial — and the FIRST open is
    // the one that worked. Production, 2026-08-21: 12:33:15 succeeded, 12:33:23
    // replayed the same code, and the person who was by then correctly
    // connected was told their calendar provider was misconfigured on our side.
    const member = await seedMember({ email: "m@foundernexus.com" });
    exchangeError = new Error(
      'Google code exchange failed (400): {"error": "invalid_grant", "error_description": "Bad Request"}'
    );

    const res = await callCallback(await connectState({ memberId: member.id }));

    expect(statusOf(res)).toBe("used");
    expect(statusOf(res)).not.toBe("provider");
  });

  it("hands out no session for a code it could not redeem", async () => {
    // The security property, and the reason this is not "notice they're already
    // connected and just log them in". The state token is minted by
    // /api/connect/start, which is PUBLIC and takes a bare email address, so
    // anyone who knows a registered address can obtain a token carrying that
    // member's id. The code exchange is the only step in this route that proves
    // the person at the other end owns the account. Issuing a session on a
    // FAILED exchange would turn a friendlier error message into a complete
    // authentication bypass.
    const member = await seedMember({ email: OWNER_EMAIL });
    await seedMember({ email: "other@foundernexus.com" });
    exchangeError = new Error('invalid_grant');

    const res = await callCallback(await connectState({ memberId: member.id }));

    const cookies = res.headers.get("set-cookie") ?? "";
    expect(cookies).not.toContain(MEMBER_COOKIE_NAME);
    expect(cookies).not.toContain(ADMIN_COOKIE_NAME);
    expect(await harness.db.select().from(calendarConnections)).toHaveLength(0);
  });

  it("still reports a genuine provider fault as one", async () => {
    // The narrower message must not swallow the case it was carved out of.
    const member = await seedMember({ email: "m@foundernexus.com" });
    exchangeError = new Error("Google code exchange failed (401): invalid_client");

    expect(statusOf(await callCallback(await connectState({ memberId: member.id })))).toBe(
      "provider"
    );
  });
});

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

describe("permissions actually granted", () => {
  it("refuses, and stores nothing, when a required permission was unticked", async () => {
    // The real incident: an advisor objected to "see and download any calendar"
    // and unticked it. The connection succeeded, the UI showed a healthy
    // calendar, and every availability search 403'd for days. A connection we
    // can't read from is worse than no connection, because no connection is
    // visible.
    const member = await seedMember({ email: "advisor@foundernexus.com" });
    exchanged.email = "advisor@foundernexus.com";
    exchanged.grantedScopes = ["https://www.googleapis.com/auth/calendar.calendarlist.readonly"];

    const res = await callCallback(await connectState({ memberId: member.id }));

    expect(statusOf(res)).toBe("permissions");
    expect(await harness.db.select().from(calendarConnections)).toHaveLength(0);
    expect(res.headers.get("set-cookie") ?? "").not.toContain(MEMBER_COOKIE_NAME);
  });

  it("accepts a broader legacy scope that covers the same ground", async () => {
    // Everyone who connected before the scopes were narrowed holds
    // calendar.readonly, which grants both things we now ask for separately.
    // Their tokens keep working and they must never be told to reconnect.
    const member = await seedMember({ email: "early@foundernexus.com" });
    exchanged.email = "early@foundernexus.com";
    exchanged.grantedScopes = [
      "https://www.googleapis.com/auth/calendar.readonly",
      "https://www.googleapis.com/auth/calendar.events",
    ];

    const res = await callCallback(await connectState({ memberId: member.id }));

    expect(destinationOf(res)).toBe("/me");
    expect(await harness.db.select().from(calendarConnections)).toHaveLength(1);
  });

  it("doesn't block when the provider reports no scopes at all", async () => {
    // `scope` isn't a guaranteed field. Absent means "we can't tell", not "they
    // granted nothing" — refusing here would lock people out over a field the
    // provider simply didn't send.
    const member = await seedMember({ email: "quiet@foundernexus.com" });
    exchanged.email = "quiet@foundernexus.com";
    exchanged.grantedScopes = [];

    const res = await callCallback(await connectState({ memberId: member.id }));

    expect(destinationOf(res)).toBe("/me");
  });

  it("only demands write access from someone who can lead a session", async () => {
    // A founder or advisor is an attendee; the invite reaches them by email and
    // needs no permission from them. Demanding write here would refuse a
    // perfectly good calendar.
    const member = await seedMember({ email: "founder@foundernexus.com" });
    exchanged.email = "founder@foundernexus.com";
    exchanged.grantedScopes = [
      "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
      "https://www.googleapis.com/auth/calendar.freebusy",
    ];

    const res = await callCallback(await connectState({ memberId: member.id }));

    expect(destinationOf(res)).toBe("/me");
    expect(await harness.db.select().from(calendarConnections)).toHaveLength(1);
  });

  it("does demand it from a facilitator, whose calendar hosts the session", async () => {
    const member = await seedMember({
      email: "lead@foundernexus.com",
      isFacilitator: true,
    });
    exchanged.email = "lead@foundernexus.com";
    exchanged.grantedScopes = [
      "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
      "https://www.googleapis.com/auth/calendar.freebusy",
    ];

    const res = await callCallback(await connectState({ memberId: member.id }));

    expect(statusOf(res)).toBe("permissions");
    expect(await harness.db.select().from(calendarConnections)).toHaveLength(0);
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
