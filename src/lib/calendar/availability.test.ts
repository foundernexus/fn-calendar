import { describe, it, expect, beforeEach, vi } from "vitest";

/** The rule this file exists to protect: a calendar we could not read must
 * never be treated as an empty one. */

const getAccessToken = vi.fn();
const fetchBusy = vi.fn();

vi.mock("@/lib/calendar/tokens", () => ({
  getAccessToken: (...args: unknown[]) => getAccessToken(...args),
}));
vi.mock("@/lib/calendar", async () => {
  const actual = await vi.importActual<typeof import("@/lib/calendar")>("@/lib/calendar");
  return { ...actual, fetchBusy: (...args: unknown[]) => fetchBusy(...args) };
});

beforeEach(() => {
  vi.clearAllMocks();
  getAccessToken.mockResolvedValue("access-token");
  fetchBusy.mockResolvedValue([]);
});

const at = (iso: string) => Math.floor(Date.parse(iso) / 1000);

function connection(over: Partial<{ id: number; provider: string; grantEmail: string }> = {}) {
  return {
    id: 1,
    provider: "google",
    grantEmail: "a@example.com",
    refreshTokenEncrypted: "encrypted",
    accessTokenEncrypted: null,
    accessTokenExpiresAt: null,
    ...over,
  };
}

async function search(connections = [connection()]) {
  const { getCollectiveAvailability } = await import("@/lib/calendar/availability");
  return getCollectiveAvailability({
    connections,
    startTime: at("2026-08-19T07:00:00Z"),
    endTime: at("2026-08-20T06:59:00Z"),
    durationMinutes: 60,
    timezone: "America/Los_Angeles",
    workingHoursStart: "09:00",
    workingHoursEnd: "17:00",
    excludeWeekends: true,
  });
}

describe("collective availability", () => {
  it("returns slots when every calendar is clear", async () => {
    expect((await search()).length).toBeGreaterThan(0);
  });

  it("fails the whole search when one calendar can't be read", async () => {
    // The tempting alternative is to skip that person and return the rest. That
    // turns "we don't know" into "they're free", and the visible result is a
    // slot confidently offered on top of an existing meeting. A failed search
    // is recoverable; a double-booking in someone's diary is not.
    fetchBusy.mockRejectedValueOnce(new Error("403 from provider"));
    const { AvailabilityUnavailableError } = await import("@/lib/calendar/availability");

    await expect(search([connection(), connection({ id: 2, grantEmail: "b@example.com" })]))
      .rejects.toBeInstanceOf(AvailabilityUnavailableError);
  });

  it("names the calendar that failed", async () => {
    // So the admin is told which person to chase, not just that something broke.
    fetchBusy.mockRejectedValueOnce(new Error("403"));
    await expect(search([connection({ grantEmail: "broken@example.com" })])).rejects.toThrow(
      /broken@example\.com/
    );
  });

  it("fails when a token can't be refreshed", async () => {
    // Same reasoning: an expired connection is unknown, not free.
    getAccessToken.mockRejectedValueOnce(new Error("has to be reconnected"));
    await expect(search()).rejects.toThrow(/Couldn't read/);
  });

  it("checks every calendar a person holds, not just one", async () => {
    await search([
      connection({ id: 1, grantEmail: "work@example.com" }),
      connection({ id: 2, grantEmail: "personal@example.com", provider: "microsoft" }),
    ]);
    expect(fetchBusy).toHaveBeenCalledTimes(2);
    // The provider travels with the connection — a member can hold a Google
    // calendar and a Microsoft one at the same time.
    expect(fetchBusy.mock.calls.map((c) => (c[0] as { provider: string }).provider).sort()).toEqual([
      "google",
      "microsoft",
    ]);
  });

  it("excludes a slot when any single calendar is busy", async () => {
    fetchBusy
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { start: at("2026-08-19T16:00:00Z"), end: at("2026-08-19T17:00:00Z") },
      ]);

    const slots = await search([
      connection({ id: 1, grantEmail: "free@example.com" }),
      connection({ id: 2, grantEmail: "busy@example.com" }),
    ]);
    // 09:00 PT is 16:00 UTC — busy for the second person, so nobody gets it.
    expect(slots.map((s) => s.startTime)).not.toContain(at("2026-08-19T16:00:00Z"));
  });
});
