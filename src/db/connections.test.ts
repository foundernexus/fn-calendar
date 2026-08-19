import { describe, it, expect } from "vitest";
import {
  pickInviteConnection,
  groupConnectionsByMember,
  connectedAtMs,
  type LatestConnectionRow,
} from "./queries";

/** Builds a connection row. `connectedAt` is deliberately a STRING by default,
 * because that's what the driver actually returns — see connectedAtMs. Tests
 * that hand it a Date are checking the other branch, not the normal case. */
function row(
  over: Partial<LatestConnectionRow> & { id: number; member_id: number }
): LatestConnectionRow {
  return {
    nylas_grant_id: `grant-${over.id}`,
    provider: "google",
    grant_email: `cal${over.id}@example.com`,
    nylas_client_id: "test-nylas-client-id",
    connection_status: "connected",
    connected_at: "2026-01-01T00:00:00.000Z",
    revoked_at: null,
    is_primary: false,
    ...over,
  };
}

describe("connectedAtMs", () => {
  it("reads the ISO string the driver actually returns", () => {
    expect(connectedAtMs(row({ id: 1, member_id: 1, connected_at: "2026-08-18T10:00:00.000Z" }))).toBe(
      Date.parse("2026-08-18T10:00:00.000Z")
    );
  });

  it("also accepts a real Date, which some callers do produce", () => {
    const d = new Date("2026-08-18T10:00:00.000Z");
    expect(connectedAtMs(row({ id: 1, member_id: 1, connected_at: d }))).toBe(d.getTime());
  });
});

describe("pickInviteConnection", () => {
  it("returns nothing when the member has no calendars", () => {
    expect(pickInviteConnection([])).toBeUndefined();
  });

  it("uses the calendar the member marked, wherever it sits in the list", () => {
    const picked = pickInviteConnection([
      row({ id: 1, member_id: 7, connected_at: "2026-01-01T00:00:00.000Z" }),
      row({ id: 2, member_id: 7, connected_at: "2026-02-01T00:00:00.000Z", is_primary: true }),
      row({ id: 3, member_id: 7, connected_at: "2026-03-01T00:00:00.000Z" }),
    ]);
    expect(picked?.id).toBe(2);
  });

  it("falls back to the OLDEST when nothing is marked", () => {
    const picked = pickInviteConnection([
      row({ id: 2, member_id: 7, connected_at: "2026-03-01T00:00:00.000Z" }),
      row({ id: 1, member_id: 7, connected_at: "2026-01-01T00:00:00.000Z" }),
    ]);
    expect(picked?.id).toBe(1);
  });

  /** The regression this ordering exists for: with a newest-first fallback,
   * connecting a second calendar silently moved every future invite onto it. */
  it("does not move when a newer calendar is added", () => {
    const before = [row({ id: 1, member_id: 7, connected_at: "2026-01-01T00:00:00.000Z" })];
    const after = [...before, row({ id: 2, member_id: 7, connected_at: "2026-06-01T00:00:00.000Z" })];
    expect(pickInviteConnection(after)?.id).toBe(pickInviteConnection(before)?.id);
  });

  /** Reconnecting resets connected_at, so a newest-first fallback would have
   * handed the invite target to whichever calendar was repaired last. */
  it("does not move when an existing calendar is reconnected", () => {
    const picked = pickInviteConnection([
      row({ id: 1, member_id: 7, connected_at: "2026-01-01T00:00:00.000Z" }),
      // id 2 was connected later originally, and has just been reconnected,
      // making it by far the most recent.
      row({ id: 2, member_id: 7, connected_at: "2026-12-01T00:00:00.000Z" }),
    ]);
    expect(picked?.id).toBe(1);
  });

  it("breaks ties on id when two rows share a timestamp", () => {
    const picked = pickInviteConnection([
      row({ id: 9, member_id: 7 }),
      row({ id: 4, member_id: 7 }),
    ]);
    expect(picked?.id).toBe(4);
  });
});

describe("groupConnectionsByMember", () => {
  it("keeps every calendar, not just one per member", () => {
    const grouped = groupConnectionsByMember([
      row({ id: 1, member_id: 7 }),
      row({ id: 2, member_id: 7 }),
      row({ id: 3, member_id: 8 }),
    ]);
    expect(grouped.get(7)?.map((r) => r.id)).toEqual([1, 2]);
    expect(grouped.get(8)?.map((r) => r.id)).toEqual([3]);
  });

  it("returns nothing for a member with no calendars", () => {
    expect(groupConnectionsByMember([]).get(7)).toBeUndefined();
  });
});
