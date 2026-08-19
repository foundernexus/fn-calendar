import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, reinstallTestDb, type TestDb } from "@/test/db";
import { seedMember, seedConnection } from "@/test/helpers";
import { calendarConnections } from "@/db/schema";
import { encryptToken, decryptToken } from "@/lib/calendar/crypto";

/** Token refresh is invisible when it works and catastrophic when it doesn't:
 * the failure mode is a calendar that quietly stops being readable hours later,
 * with nothing on any screen to say so. */

let harness: TestDb;

const refreshGoogle = vi.fn();
const refreshMicrosoft = vi.fn();
vi.mock("@/lib/calendar/google", () => ({
  refreshGoogleToken: (t: string) => refreshGoogle(t),
}));
vi.mock("@/lib/calendar/microsoft", () => ({
  refreshMicrosoftToken: (t: string) => refreshMicrosoft(t),
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
  vi.resetModules();
  await reinstallTestDb();
});

async function tokens() {
  return import("@/lib/calendar/tokens");
}

const HOUR = 60 * 60 * 1000;

async function connectionRow(over: Parameters<typeof seedConnection>[0] & {
  refreshToken?: string;
  accessToken?: string;
  expiresAt?: Date | null;
}) {
  const conn = await seedConnection(over);
  await harness.db
    .update(calendarConnections)
    .set({
      refreshTokenEncrypted: over.refreshToken ? encryptToken(over.refreshToken) : null,
      accessTokenEncrypted: over.accessToken ? encryptToken(over.accessToken) : null,
      accessTokenExpiresAt: over.expiresAt ?? null,
    })
    .where(eq(calendarConnections.id, conn.id));
  const [row] = await harness.db
    .select()
    .from(calendarConnections)
    .where(eq(calendarConnections.id, conn.id));
  return row;
}

describe("getting an access token", () => {
  it("uses the cached one when it has time left", async () => {
    const member = await seedMember({ email: "m@example.com" });
    const row = await connectionRow({
      memberId: member.id,
      grantEmail: "m@example.com",
      grantId: "g-1",
      refreshToken: "refresh-1",
      accessToken: "cached-access",
      expiresAt: new Date(Date.now() + HOUR),
    });

    const { getAccessToken } = await tokens();
    expect(await getAccessToken(row)).toBe("cached-access");
    // The whole point of the cache: no round trip on every availability search.
    expect(refreshGoogle).not.toHaveBeenCalled();
  });

  it("refreshes when the cached token is about to expire", async () => {
    // Valid for another 30 seconds. Using it would 401 mid-booking, which is
    // exactly the moment you least want a failure.
    const member = await seedMember({ email: "m@example.com" });
    const row = await connectionRow({
      memberId: member.id,
      grantEmail: "m@example.com",
      grantId: "g-1",
      refreshToken: "refresh-1",
      accessToken: "nearly-dead",
      expiresAt: new Date(Date.now() + 30_000),
    });
    refreshGoogle.mockResolvedValue({
      accessToken: "fresh-access",
      expiresAt: new Date(Date.now() + HOUR),
    });

    const { getAccessToken } = await tokens();
    expect(await getAccessToken(row)).toBe("fresh-access");
    expect(refreshGoogle).toHaveBeenCalledWith("refresh-1");
  });

  it("persists a rotated Microsoft refresh token", async () => {
    const member = await seedMember({ email: "m@example.com" });
    const row = await connectionRow({
      memberId: member.id,
      provider: "microsoft",
      grantEmail: "m@example.com",
      grantId: "g-1",
      refreshToken: "old-refresh",
    });
    refreshMicrosoft.mockResolvedValue({
      accessToken: "fresh-access",
      refreshToken: "rotated-refresh",
      expiresAt: new Date(Date.now() + HOUR),
    });

    const { getAccessToken } = await tokens();
    await getAccessToken(row);

    const [after] = await harness.db
      .select()
      .from(calendarConnections)
      .where(eq(calendarConnections.id, row.id));
    // Microsoft retires the old token when it issues a new one. Failing to
    // save this means the connection works until the next rotation and then
    // dies for good, with no error at the time it breaks.
    expect(decryptToken(after.refreshTokenEncrypted!)).toBe("rotated-refresh");
  });

  it("keeps the existing refresh token when Google returns none", async () => {
    const member = await seedMember({ email: "m@example.com" });
    const row = await connectionRow({
      memberId: member.id,
      grantEmail: "m@example.com",
      grantId: "g-1",
      refreshToken: "keep-me",
    });
    refreshGoogle.mockResolvedValue({
      accessToken: "fresh-access",
      expiresAt: new Date(Date.now() + HOUR),
    });

    const { getAccessToken } = await tokens();
    await getAccessToken(row);

    const [after] = await harness.db
      .select()
      .from(calendarConnections)
      .where(eq(calendarConnections.id, row.id));
    expect(decryptToken(after.refreshTokenEncrypted!)).toBe("keep-me");
  });

  it("stores the new access token so the next call is free", async () => {
    const member = await seedMember({ email: "m@example.com" });
    const row = await connectionRow({
      memberId: member.id,
      grantEmail: "m@example.com",
      grantId: "g-1",
      refreshToken: "refresh-1",
    });
    refreshGoogle.mockResolvedValue({
      accessToken: "fresh-access",
      expiresAt: new Date(Date.now() + HOUR),
    });

    const { getAccessToken } = await tokens();
    await getAccessToken(row);

    const [after] = await harness.db
      .select()
      .from(calendarConnections)
      .where(eq(calendarConnections.id, row.id));
    expect(decryptToken(after.accessTokenEncrypted!)).toBe("fresh-access");
    expect(after.accessTokenExpiresAt).not.toBeNull();
  });

  it("refreshes rather than failing when the cached token is corrupt", async () => {
    const member = await seedMember({ email: "m@example.com" });
    const conn = await seedConnection({
      memberId: member.id,
      grantEmail: "m@example.com",
      grantId: "g-1",
    });
    await harness.db
      .update(calendarConnections)
      .set({
        refreshTokenEncrypted: encryptToken("refresh-1"),
        accessTokenEncrypted: "not-even-our-format",
        accessTokenExpiresAt: new Date(Date.now() + HOUR),
      })
      .where(eq(calendarConnections.id, conn.id));
    const [row] = await harness.db
      .select()
      .from(calendarConnections)
      .where(eq(calendarConnections.id, conn.id));
    refreshGoogle.mockResolvedValue({
      accessToken: "fresh-access",
      expiresAt: new Date(Date.now() + HOUR),
    });

    // A damaged CACHE is recoverable — it should cost one round trip, not an
    // outage. A damaged refresh token would be different.
    const { getAccessToken } = await tokens();
    expect(await getAccessToken(row)).toBe("fresh-access");
  });

  it("refuses a pre-switch Nylas row with a message that says what to do", async () => {
    const member = await seedMember({ email: "m@example.com" });
    const row = await connectionRow({
      memberId: member.id,
      grantEmail: "m@example.com",
      grantId: "g-nylas",
      // No refresh token — this is what every existing row looks like.
    });

    const { getAccessToken, ConnectionUnusableError } = await tokens();
    await expect(getAccessToken(row)).rejects.toBeInstanceOf(ConnectionUnusableError);
    await expect(getAccessToken(row)).rejects.toThrow(/reconnected/);
  });
});

describe("storing a new connection", () => {
  it("refuses when the provider returned no refresh token", async () => {
    // Google only issues one on a FIRST authorisation. A row saved without it
    // looks connected, works for an hour, then goes quiet.
    const { encryptedTokenFields } = await tokens();
    expect(() =>
      encryptedTokenFields({ accessToken: "a", expiresAt: new Date() })
    ).toThrow(/no refresh token/);
  });

  it("encrypts both tokens", async () => {
    const { encryptedTokenFields } = await tokens();
    const fields = encryptedTokenFields({
      accessToken: "access-1",
      refreshToken: "refresh-1",
      expiresAt: new Date(Date.now() + HOUR),
    });
    expect(fields.refreshTokenEncrypted).not.toContain("refresh-1");
    expect(decryptToken(fields.refreshTokenEncrypted)).toBe("refresh-1");
    expect(decryptToken(fields.accessTokenEncrypted)).toBe("access-1");
  });
});
