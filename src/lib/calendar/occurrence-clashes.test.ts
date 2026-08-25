import { describe, it, expect, vi, beforeEach } from "vitest";

/** Telling a real clash apart from the session's own footprint.
 *
 * This is the logic the daily look-ahead runs on, and until now it was replaced
 * wholesale by a mock in every test that touched it — which is how it went
 * unnoticed that the check it used to call answers "busy" for every date of
 * every series, because the series itself is sitting in the slot. */

const SLOT_START = Math.floor(new Date("2026-10-14T17:00:00Z").getTime() / 1000);
const SLOT_END = SLOT_START + 1800;

/** Busy blocks the fake provider reports, per connected address. */
let busyByEmail: Record<string, { start: number; end: number }[]> = {};
/** Addresses whose calendar cannot be read at all. */
let unreadable: string[] = [];

vi.mock("@/db/queries", () => ({
  getActiveConnections: async () => [
    { member_id: 1, provider: "google", grant_email: "karin@foundernexus.com" },
    { member_id: 2, provider: "google", grant_email: "yuan@example.com" },
  ],
  getMembersByIds: async () => [
    { id: 1, fullName: "Karin", email: "karin@foundernexus.com" },
    { id: 2, fullName: "Yuan Sun", email: "yuan@example.com" },
  ],
  connectionCredentials: (c: { grant_email: string }) => c,
  getMemberAvailabilityForMembers: async () => [],
}));
vi.mock("@/lib/calendar/tokens", () => ({ getAccessToken: async () => "token" }));
vi.mock("@/lib/calendar", () => ({
  asCalendarProvider: () => "google",
  fetchBusy: async ({ email }: { email: string }) => {
    if (unreadable.includes(email)) throw new Error("calendar unreadable");
    return busyByEmail[email] ?? [];
  },
}));
vi.mock("@/lib/calendar/availability", () => ({ getCollectiveAvailability: async () => ({}) }));

async function clashes() {
  const { occurrenceClashes } = await import("@/lib/calendar/booking-guards");
  return occurrenceClashes({
    memberIds: [1, 2],
    startUnix: SLOT_START,
    endUnix: SLOT_END,
    context: "test",
  });
}

beforeEach(() => {
  busyByEmail = {};
  unreadable = [];
  vi.resetModules();
});

describe("what counts as a clash", () => {
  it("ignores the session's own entry in everyone's calendar", async () => {
    // THE case this exists for. Once a series is booked, every participant is
    // busy at every one of its dates — with this session. Reading that as a
    // clash would put every date of every series on Karin's list every morning,
    // and a list that is wrong daily is a list nobody opens.
    busyByEmail = {
      "karin@foundernexus.com": [{ start: SLOT_START, end: SLOT_END }],
      "yuan@example.com": [{ start: SLOT_START, end: SLOT_END }],
    };
    expect(await clashes()).toEqual([]);
  });

  it("catches a longer meeting booked over the date", async () => {
    // The shape a real clash usually has: somebody drops an hour across a
    // half-hour session.
    busyByEmail = {
      "yuan@example.com": [{ start: SLOT_START - 900, end: SLOT_END + 900 }],
    };
    expect(await clashes()).toEqual(["Yuan Sun"]);
  });

  it("catches something that only overlaps the end", async () => {
    busyByEmail = {
      "karin@foundernexus.com": [{ start: SLOT_END - 600, end: SLOT_END + 3600 }],
    };
    expect(await clashes()).toEqual(["Karin"]);
  });

  it("does not mind a meeting that merely sits next to it", async () => {
    // Back-to-back is a normal day, not a conflict. Quiet time either side is
    // the buffer's job, and it belongs to booking rather than to this list.
    busyByEmail = {
      "yuan@example.com": [{ start: SLOT_END, end: SLOT_END + 3600 }],
    };
    expect(await clashes()).toEqual([]);
  });

  it("forgives a minute of drift at the edges", async () => {
    // Providers round and re-encode times. A block thirty seconds wider than
    // ours is the same meeting, not a new one.
    busyByEmail = {
      "yuan@example.com": [{ start: SLOT_START - 30, end: SLOT_END + 30 }],
    };
    expect(await clashes()).toEqual([]);
  });

  it("reports nothing for a calendar it could not read", async () => {
    // Fails open, like every other calendar check here. A false alarm costs
    // more than a missed one: the value of this list is that everything on it
    // is worth looking at.
    unreadable = ["yuan@example.com"];
    expect(await clashes()).toEqual([]);
  });

  it("still reports the readable half when one calendar is down", async () => {
    unreadable = ["yuan@example.com"];
    busyByEmail = {
      "karin@foundernexus.com": [{ start: SLOT_START - 3600, end: SLOT_END }],
    };
    expect(await clashes()).toEqual(["Karin"]);
  });
});
