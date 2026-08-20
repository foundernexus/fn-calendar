import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/env", () => ({
  env: {
    MICROSOFT_CLIENT_ID: "test-client-id",
    MICROSOFT_CLIENT_SECRET: "test-secret",
    MICROSOFT_TENANT: "common",
    APP_URL: "https://scheduler.example.com",
  },
}));

/** Which address a Microsoft account resolves to, and why it is not `mail`.
 *
 * This is the value the OAuth callback compares against a registered member's
 * address, and that comparison is the only thing establishing that whoever
 * finished the round trip owns the account being bound. Getting it from a
 * field the signer can edit is an account takeover, so it gets its own test. */

type GraphMe = { mail?: string; userPrincipalName?: string };

function mockGraph(me: GraphMe) {
  return vi.fn(async (url: string | URL) => {
    const href = String(url);
    if (href.includes("/oauth2/v2.0/token")) {
      return new Response(
        JSON.stringify({
          access_token: "access-token",
          refresh_token: "refresh-token",
          expires_in: 3600,
          scope: "offline_access User.Read Calendars.Read",
        }),
        { status: 200 }
      );
    }
    if (href.includes("/me")) {
      return new Response(JSON.stringify(me), { status: 200 });
    }
    throw new Error(`unexpected fetch: ${href}`);
  });
}

/** Runs a full code exchange against a stubbed Graph and reports the address
 * the connection would be bound to. */
async function resolveEmail(me: GraphMe) {
  vi.stubGlobal("fetch", mockGraph(me));
  const { exchangeMicrosoftCode } = await import("@/lib/calendar/microsoft");
  return (await exchangeMicrosoftCode("any-code")).email;
}

beforeEach(() => {
  vi.resetModules();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("which address a Microsoft account resolves to", () => {
  it("uses userPrincipalName, not mail, when the two disagree", async () => {
    // THE takeover. `mail` is a mutable directory attribute: an attacker who
    // runs their own tenant can set it to any address on any domain, including
    // one they have never proved they own. The UPN suffix must be a verified
    // domain of the tenant, so it cannot be pointed at someone else's company.
    //
    // If this ever flips back, a free Entra tenant plus a known member address
    // is enough to be handed that member's session — or an admin's.
    const resolved = await resolveEmail({
      mail: "victim@foundernexus.com",
      userPrincipalName: "attacker@evil.onmicrosoft.com",
    });

    expect(resolved).toBe("attacker@evil.onmicrosoft.com");
    expect(resolved).not.toBe("victim@foundernexus.com");
  });

  it("still resolves a personal Outlook account, which reports no mail", async () => {
    // The reason `mail` was read first originally. Personal accounts leave it
    // empty and carry the address in the UPN, so they are unaffected by the
    // reordering — this is what makes the fix safe for the accounts we hold.
    expect(await resolveEmail({ userPrincipalName: "someone@outlook.com" })).toBe(
      "someone@outlook.com"
    );
  });

  it("falls back to mail only when there is no userPrincipalName", async () => {
    // Kept so a directory without a usable UPN can still connect. Only
    // reachable when there is no verified value to override.
    expect(await resolveEmail({ mail: "someone@company.com" })).toBe("someone@company.com");
  });

  it("refuses a guest account", async () => {
    // `person_theirdomain.com#EXT#@host.onmicrosoft.com` names a guest
    // relationship, not a mailbox — an invitation sent to it goes nowhere.
    await expect(
      resolveEmail({ userPrincipalName: "person_other.com#EXT#@host.onmicrosoft.com" })
    ).rejects.toThrow(/guest/i);
  });

  it("refuses an account with no address at all", async () => {
    await expect(resolveEmail({})).rejects.toThrow(/no email/i);
  });
});
