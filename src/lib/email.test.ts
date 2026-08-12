import { describe, it, expect } from "vitest";
import { normalizeEmail } from "./email";

describe("normalizeEmail", () => {
  it("lowercases and trims", () => {
    expect(normalizeEmail("  Tobias@FounderNexus.com  ")).toBe("tobias@foundernexus.com");
  });

  it("is idempotent", () => {
    const once = normalizeEmail("Tobias@FounderNexus.com");
    expect(normalizeEmail(once)).toBe(once);
  });
});
