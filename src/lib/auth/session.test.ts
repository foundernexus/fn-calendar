import { describe, it, expect } from "vitest";
import { signValue, verifyValue, TOKEN_PURPOSE } from "./session";

const SECRET = "test-secret-at-least-32-characters-long";

describe("signValue / verifyValue", () => {
  it("round-trips a payload correctly", async () => {
    const token = await signValue(TOKEN_PURPOSE.adminSession, { email: "a@b.com" }, SECRET, 3600);
    const result = await verifyValue<{ email: string }>(TOKEN_PURPOSE.adminSession, token, SECRET);
    expect(result?.email).toBe("a@b.com");
  });

  it("rejects a token verified against the wrong purpose", async () => {
    // A token minted for one use (e.g. the OAuth state param) must not be
    // replayable somewhere expecting a different shape — this is the whole
    // reason `purpose` is embedded and checked at all.
    const token = await signValue(TOKEN_PURPOSE.connectState, { memberId: 1 }, SECRET, 3600);
    const result = await verifyValue(TOKEN_PURPOSE.adminSession, token, SECRET);
    expect(result).toBeNull();
  });

  it("rejects a token signed with a different secret", async () => {
    const token = await signValue(TOKEN_PURPOSE.adminSession, { email: "a@b.com" }, SECRET, 3600);
    const result = await verifyValue(TOKEN_PURPOSE.adminSession, token, "a-completely-different-secret-value");
    expect(result).toBeNull();
  });

  it("rejects an expired token", async () => {
    const token = await signValue(TOKEN_PURPOSE.adminSession, { email: "a@b.com" }, SECRET, -1);
    const result = await verifyValue(TOKEN_PURPOSE.adminSession, token, SECRET);
    expect(result).toBeNull();
  });

  it("rejects a tampered payload even with a valid-looking signature", async () => {
    const token = await signValue(TOKEN_PURPOSE.adminSession, { email: "a@b.com" }, SECRET, 3600);
    const [payloadB64, sigB64] = token.split(".");
    // Flip one character in the payload — the signature no longer matches.
    const tamperedPayload = payloadB64.slice(0, -1) + (payloadB64.at(-1) === "A" ? "B" : "A");
    const tamperedToken = `${tamperedPayload}.${sigB64}`;
    const result = await verifyValue(TOKEN_PURPOSE.adminSession, tamperedToken, SECRET);
    expect(result).toBeNull();
  });

  it("rejects garbage input without throwing", async () => {
    await expect(verifyValue(TOKEN_PURPOSE.adminSession, "not-a-real-token", SECRET)).resolves.toBeNull();
    await expect(verifyValue(TOKEN_PURPOSE.adminSession, "", SECRET)).resolves.toBeNull();
    await expect(verifyValue(TOKEN_PURPOSE.adminSession, "a.b.c", SECRET)).resolves.toBeNull();
  });
});
