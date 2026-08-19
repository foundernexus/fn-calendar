import { describe, it, expect } from "vitest";
import { encryptToken, decryptToken } from "@/lib/calendar/crypto";

/** These tokens are live keys to people's calendars. The properties below are
 * the difference between a database dump being useless and being a set of
 * working credentials. */

const TOKEN = "1//0gExAmPleRefreshToken-abcdefghijklmnopqrstuvwxyz0123456789";

describe("token encryption", () => {
  it("round-trips", () => {
    expect(decryptToken(encryptToken(TOKEN))).toBe(TOKEN);
  });

  it("never emits the plaintext", () => {
    expect(encryptToken(TOKEN)).not.toContain("ExAmPleRefreshToken");
  });

  it("produces a different ciphertext every time", () => {
    // A fresh IV per call. Without it, two members holding the same token — or
    // one member reconnecting — would produce identical rows, and equal
    // ciphertexts leak that the underlying values are equal.
    expect(encryptToken(TOKEN)).not.toBe(encryptToken(TOKEN));
  });

  it("refuses a tampered ciphertext instead of returning rubbish", () => {
    const encrypted = encryptToken(TOKEN);
    const parts = encrypted.split(".");
    // Flip the last character of the ciphertext.
    const last = parts[3];
    parts[3] = last.slice(0, -1) + (last.endsWith("A") ? "B" : "A");
    // GCM authentication is what makes this throw. Without it a corrupted row
    // would decrypt to a token-shaped string and fail later against the
    // provider, where the real cause is invisible.
    expect(() => decryptToken(parts.join("."))).toThrow();
  });

  it("refuses a swapped authentication tag", () => {
    const a = encryptToken(TOKEN).split(".");
    const b = encryptToken("a-different-token").split(".");
    expect(() => decryptToken([a[0], a[1], b[2], a[3]].join("."))).toThrow();
  });

  it("rejects anything that isn't our format", () => {
    expect(() => decryptToken("plaintext-token")).toThrow(/expected encrypted format/);
    expect(() => decryptToken("v2.a.b.c")).toThrow(/expected encrypted format/);
  });

  it("refuses to encrypt nothing", () => {
    // An empty token stored successfully would read as "connected" while being
    // unusable — the failure has to happen here, loudly.
    expect(() => encryptToken("")).toThrow();
  });

  it("handles a long token", () => {
    const long = "x".repeat(4000);
    expect(decryptToken(encryptToken(long))).toBe(long);
  });
});
