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

function connection(
  over: Partial<{
    id: number;
    provider: string;
    grantEmail: string;
    bufferBeforeMinutes: number;
    bufferAfterMinutes: number;
  }> = {}
) {
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

async function search(connections = [connection()], leadMinutes?: number, includeBusy?: boolean) {
  const { getCollectiveAvailability } = await import("@/lib/calendar/availability");
  return getCollectiveAvailability({
    connections,
    leadMinutes,
    includeBusy,
    startTime: at("2026-08-19T07:00:00Z"),
    endTime: at("2026-08-20T06:59:00Z"),
    durationMinutes: 60,
    timezone: "America/Los_Angeles",
    workingHoursStart: "09:00",
    workingHoursEnd: "17:00",
    excludeWeekends: true,
  });
}

/** 10:00–11:00 PT on the searched day. */
const MEETING = [{ start: at("2026-08-19T17:00:00Z"), end: at("2026-08-19T18:00:00Z") }];

describe("booking over busy time", () => {
  it("says nothing about who's busy unless asked", async () => {
    // The default answer has to stay the answer it always was. A search that
    // starts volunteering busy times changes what every existing caller renders.
    fetchBusy.mockResolvedValue(MEETING);
    expect((await search()).busySlots).toEqual([]);
  });

  it("names whose calendar is busy when asked", async () => {
    fetchBusy.mockResolvedValue(MEETING);

    const result = await search([connection({ grantEmail: "held@example.com" })], undefined, true);

    const tenAm = result.busySlots.find((s) => s.startTime === at("2026-08-19T17:00:00Z"));
    expect(tenAm?.busyEmails).toEqual(["held@example.com"]);
    // And the free list is untouched by any of it — the two never overlap.
    expect(result.slots.map((s) => s.startTime)).not.toContain(at("2026-08-19T17:00:00Z"));
  });

  it("reports somebody busy under the buffer they set for themselves", async () => {
    // A buffer widens busy time before any of this runs, so the 11:00 slot that
    // touches a 10:00–11:00 meeting is busy-with-a-name rather than silently
    // absent. Consistent in both directions: it is the same padding the free
    // list is computed from.
    fetchBusy.mockResolvedValue(MEETING);

    const result = await search(
      [connection({ grantEmail: "padded@example.com", bufferAfterMinutes: 30 })],
      undefined,
      true
    );

    expect(result.busySlots.map((s) => s.startTime)).toContain(at("2026-08-19T18:00:00Z"));
  });

  it("keeps counting droppedByLead over free slots only", async () => {
    // The reason busySlots is a field of its own. droppedByLead, blockers and
    // everything the route builds on them count FREE time; if asking for busy
    // slots moved that number, every diagnostic on the page would quietly start
    // answering a different question.
    fetchBusy.mockResolvedValue(MEETING);

    const without = await search([connection()], 15);
    const with_ = await search([connection()], 15, true);

    expect(with_.droppedByLead).toBe(without.droppedByLead);
    expect(with_.slots.map((s) => s.startTime)).toEqual(without.slots.map((s) => s.startTime));
  });
});

describe("collective availability", () => {
  it("returns slots when every calendar is clear", async () => {
    expect((await search()).slots.length).toBeGreaterThan(0);
  });

  it("keeps searching when one calendar can't be read, and says which", async () => {
    // This used to abandon the entire search, on the reasoning that skipping a
    // calendar turns "we don't know" into "they're free". The reasoning holds —
    // the word carrying it is *quietly*. What broke was the scale: on
    // 2026-08-21 one participant with a withheld permission took down a search
    // across five people, and every one of the other four calendars was read
    // successfully and thrown away.
    //
    // So the danger moves rather than disappearing, and `unreadable` is the
    // whole mitigation. A caller that drops it shows an admin times that were
    // computed without someone in them, with nothing on screen to say so.
    fetchBusy.mockRejectedValueOnce(new Error("403 from provider"));

    const result = await search([
      connection({ id: 1, grantEmail: "broken@example.com" }),
      connection({ id: 2, grantEmail: "fine@example.com" }),
    ]);

    expect(result.unreadable).toEqual(["broken@example.com"]);
    expect(result.slots.length).toBeGreaterThan(0);
  });

  it("reports a calendar whose token can't be refreshed", async () => {
    // Same path, different cause: an expired connection is unknown, not free,
    // and has to be named for the same reason.
    getAccessToken.mockRejectedValueOnce(new Error("has to be reconnected"));

    const result = await search([connection({ grantEmail: "stale@example.com" })]);
    expect(result.unreadable).toEqual(["stale@example.com"]);
  });

  it("reports nothing unreadable when every calendar answers", async () => {
    // The other half of the contract. If this could return a false empty, the
    // warning would vanish from the screen while the risk stayed.
    expect((await search()).unreadable).toEqual([]);
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

    const { slots } = await search([
      connection({ id: 1, grantEmail: "free@example.com" }),
      connection({ id: 2, grantEmail: "busy@example.com" }),
    ]);
    // 09:00 PT is 16:00 UTC — busy for the second person, so nobody gets it.
    expect(slots.map((s) => s.startTime)).not.toContain(at("2026-08-19T16:00:00Z"));
  });
});

describe("gaps around meetings", () => {
  it("keeps a slot free of the buffer either side of a real meeting", async () => {
    // 10:00–11:00 PT is 17:00–18:00 UTC. With 30 minutes kept clear afterwards,
    // the 11:00 slot is no longer offered even though the calendar is empty
    // then — which is the whole point: a Nexus Partner needs the gap to write
    // the follow-up before the next call starts.
    fetchBusy.mockResolvedValue([
      { start: at("2026-08-19T17:00:00Z"), end: at("2026-08-19T18:00:00Z") },
    ]);

    const { slots } = await search([connection({ bufferAfterMinutes: 30 })]);
    const starts = slots.map((s) => s.startTime);

    expect(starts).not.toContain(at("2026-08-19T18:00:00Z")); // 11:00, inside the gap
    expect(starts).toContain(at("2026-08-19T19:00:00Z")); // 12:00, clear of it
  });

  it("blocks the slot that would end right as a meeting starts", async () => {
    // The other side. A 60-minute slot at 09:00 ends exactly when the 10:00
    // meeting begins, which is precisely the back-to-back this prevents.
    fetchBusy.mockResolvedValue([
      { start: at("2026-08-19T17:00:00Z"), end: at("2026-08-19T18:00:00Z") },
    ]);

    const { slots } = await search([connection({ bufferBeforeMinutes: 15 })]);
    expect(slots.map((s) => s.startTime)).not.toContain(at("2026-08-19T16:00:00Z"));
  });

  it("changes nothing for someone who set no buffer", async () => {
    // The default, and it has to stay the default: a founder scheduled into the
    // occasional session never asked for their availability to be narrowed.
    fetchBusy.mockResolvedValue([
      { start: at("2026-08-19T17:00:00Z"), end: at("2026-08-19T18:00:00Z") },
    ]);

    const { slots } = await search([connection()]);
    expect(slots.map((s) => s.startTime)).toContain(at("2026-08-19T18:00:00Z"));
  });
});

describe("run-up before the session", () => {
  it("drops the slot that starts the moment another meeting ends", async () => {
    // The whole point: people turn up late because their previous call ran to
    // the minute this one begins. 10:00-11:00 PT is 17:00-18:00 UTC, so with a
    // quarter-hour run-up the 11:00 slot goes and 12:00 stays.
    fetchBusy.mockResolvedValue([
      { start: at("2026-08-19T17:00:00Z"), end: at("2026-08-19T18:00:00Z") },
    ]);

    const { slots } = await search([connection()], 15);
    const starts = slots.map((s) => s.startTime);

    expect(starts).not.toContain(at("2026-08-19T18:00:00Z")); // 11:00, straight out of a call
    expect(starts).toContain(at("2026-08-19T19:00:00Z")); // 12:00, clear run-up
  });

  it("reports how many times it cost", async () => {
    // Said out loud, because a search that quietly returns fewer results than
    // it could reads as "nobody is free" rather than "you asked for a gap".
    fetchBusy.mockResolvedValue([
      { start: at("2026-08-19T17:00:00Z"), end: at("2026-08-19T18:00:00Z") },
    ]);

    const withLead = await search([connection()], 15);
    const without = await search([connection()], 0);

    expect(withLead.droppedByLead).toBe(without.slots.length - withLead.slots.length);
    expect(withLead.droppedByLead).toBeGreaterThan(0);
  });

  it("costs nothing and reports nothing when it isn't asked for", async () => {
    fetchBusy.mockResolvedValue([
      { start: at("2026-08-19T17:00:00Z"), end: at("2026-08-19T18:00:00Z") },
    ]);
    const result = await search([connection()]);
    expect(result.droppedByLead).toBe(0);
    expect(result.slots.map((s) => s.startTime)).toContain(at("2026-08-19T18:00:00Z"));
  });

  it("stacks on top of a personal buffer rather than replacing it", async () => {
    // Someone who keeps 30 minutes to themselves does not get less protection
    // because a search asked for 15.
    fetchBusy.mockResolvedValue([
      { start: at("2026-08-19T17:00:00Z"), end: at("2026-08-19T18:00:00Z") },
    ]);
    const { slots } = await search([connection({ bufferAfterMinutes: 30 })], 15);
    expect(slots.map((s) => s.startTime)).not.toContain(at("2026-08-19T18:30:00Z"));
  });
});

describe("who is the constraint", () => {
  const groups = [
    { label: "Yuan", emails: ["yuan@example.com"] },
    { label: "Court", emails: ["court@example.com"] },
  ];

  async function searchWithGroups(connections: ReturnType<typeof connection>[]) {
    const { getCollectiveAvailability } = await import("@/lib/calendar/availability");
    return getCollectiveAvailability({
      connections,
      blockerGroups: groups,
      startTime: at("2026-08-19T07:00:00Z"),
      endTime: at("2026-08-20T06:59:00Z"),
      durationMinutes: 60,
      timezone: "America/Los_Angeles",
      workingHoursStart: "09:00",
      workingHoursEnd: "17:00",
      excludeWeekends: true,
    });
  }

  it("names the person whose absence unlocks the day", async () => {
    // Yuan is busy all day, Court is free. "No overlapping free time" is true
    // and tells an admin nothing; knowing it is Yuan is the difference between
    // widening the range and dropping one person.
    fetchBusy
      .mockResolvedValueOnce([
        { start: at("2026-08-19T15:00:00Z"), end: at("2026-08-20T02:00:00Z") },
      ])
      .mockResolvedValueOnce([]);

    const { slots, blockers } = await searchWithGroups([
      connection({ id: 1, grantEmail: "yuan@example.com" }),
      connection({ id: 2, grantEmail: "court@example.com" }),
    ]);

    expect(slots).toHaveLength(0);
    expect(blockers[0].label).toBe("Yuan");
    expect(blockers[0].slotsWithout).toBeGreaterThan(0);
    // Court unlocks nothing, so he must not be offered as the answer.
    expect(blockers.find((b) => b.label === "Court")!.slotsWithout).toBe(0);
  });

  it("says nothing when there are times on offer", async () => {
    // Wasted work on a question nobody is asking, and a suggestion to drop
    // someone from a session that already has a slot would be nonsense.
    const { slots, blockers } = await searchWithGroups([
      connection({ id: 1, grantEmail: "yuan@example.com" }),
      connection({ id: 2, grantEmail: "court@example.com" }),
    ]);
    expect(slots.length).toBeGreaterThan(0);
    expect(blockers).toEqual([]);
  });

  it("reports nobody when removing any one person still leaves nothing", async () => {
    // Both are blocked all day. The range is the problem, not a person — and
    // naming one would send an admin to have a pointless conversation.
    fetchBusy.mockResolvedValue([
      { start: at("2026-08-19T15:00:00Z"), end: at("2026-08-20T02:00:00Z") },
    ]);

    const { blockers } = await searchWithGroups([
      connection({ id: 1, grantEmail: "yuan@example.com" }),
      connection({ id: 2, grantEmail: "court@example.com" }),
    ]);
    expect(blockers.every((b) => b.slotsWithout === 0)).toBe(true);
  });
});
