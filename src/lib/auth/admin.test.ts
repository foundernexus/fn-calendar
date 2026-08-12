import { describe, it, expect } from "vitest";
import { isAdminEmail } from "./admin";

describe("isAdminEmail", () => {
  const allowlist = "tobias@foundernexus.com,karink@foundernexus.com";

  it("matches an email on the allowlist", () => {
    expect(isAdminEmail("tobias@foundernexus.com", allowlist)).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(isAdminEmail("Tobias@FounderNexus.com", allowlist)).toBe(true);
  });

  it("rejects an email not on the allowlist", () => {
    expect(isAdminEmail("attacker@example.com", allowlist)).toBe(false);
  });

  it("treats a blank allowlist as denying everyone", () => {
    expect(isAdminEmail("tobias@foundernexus.com", "")).toBe(false);
  });

  it("ignores stray whitespace around entries", () => {
    expect(isAdminEmail("tobias@foundernexus.com", " tobias@foundernexus.com , karink@foundernexus.com ")).toBe(
      true
    );
  });
});
