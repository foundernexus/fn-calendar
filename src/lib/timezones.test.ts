import { describe, it, expect } from "vitest";
import { isSupportedTimezone, timezoneLabel } from "./timezones";

describe("isSupportedTimezone", () => {
  it("accepts a real IANA zone", () => {
    expect(isSupportedTimezone("America/Los_Angeles")).toBe(true);
  });

  it("accepts an older alias the same way as its canonical name", () => {
    // The exact motivation in this function's own comment — an alias must
    // validate the same as the zone it points to, since the check is
    // "can the runtime construct a formatter," not list membership.
    expect(isSupportedTimezone("Asia/Calcutta")).toBe(true);
    expect(isSupportedTimezone("Asia/Kolkata")).toBe(true);
  });

  it("rejects a nonsense string", () => {
    expect(isSupportedTimezone("Not/A_Real_Zone")).toBe(false);
  });

  it("rejects an empty string", () => {
    expect(isSupportedTimezone("")).toBe(false);
  });
});

describe("timezoneLabel", () => {
  it("derives a readable city name and a GMT offset", () => {
    const label = timezoneLabel("America/Los_Angeles");
    expect(label).toMatch(/^Los Angeles — GMT[+-]\d+$/);
  });

  it("replaces underscores with spaces in multi-word city names", () => {
    const label = timezoneLabel("America/New_York");
    expect(label.startsWith("New York")).toBe(true);
  });
});
