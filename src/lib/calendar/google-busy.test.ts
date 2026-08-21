import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/env", () => ({
  env: {
    GOOGLE_CLIENT_ID: "test-client-id",
    GOOGLE_CLIENT_SECRET: "test-secret",
    APP_URL: "https://scheduler.example.com",
  },
}));

/** Which calendars a free/busy read covers, and what it does when one of them
 * can't be read.
 *
 * Both halves decide whether someone gets offered a slot they aren't free for,
 * which is the one mistake this app cannot make quietly. */

type Busy = { start: string; end: string };
type FreeBusyEntry = { busy?: Busy[]; errors?: { reason: string }[] };

/** Captures the calendar ids the freeBusy call actually asked about. */
let askedFor: string[] = [];

function stubGoogle(opts: {
  /** Calendars the list endpoint returns, or "denied" to make it 403 the way
   * it now does for anyone not asked for calendar.calendarlist.readonly. */
  list: string[] | "denied";
  freeBusy: Record<string, FreeBusyEntry>;
}) {
  askedFor = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      const href = String(url);

      if (href.includes("/users/me/calendarList")) {
        if (opts.list === "denied") {
          return new Response(
            JSON.stringify({ error: { code: 403, message: "Insufficient Permission" } }),
            { status: 403 }
          );
        }
        return new Response(JSON.stringify({ items: opts.list.map((id) => ({ id })) }), {
          status: 200,
        });
      }

      if (href.includes("/freeBusy")) {
        const body = JSON.parse(String(init?.body)) as { items: { id: string }[] };
        askedFor.push(...body.items.map((i) => i.id));
        return new Response(JSON.stringify({ calendars: opts.freeBusy }), { status: 200 });
      }

      throw new Error(`unexpected fetch: ${href}`);
    })
  );
}

async function busyFor(opts: Parameters<typeof stubGoogle>[0]) {
  stubGoogle(opts);
  const { fetchGoogleBusy } = await import("@/lib/calendar/google");
  return fetchGoogleBusy({
    accessToken: "access-token",
    startTime: Math.floor(Date.parse("2026-09-01T00:00:00Z") / 1000),
    endTime: Math.floor(Date.parse("2026-09-02T00:00:00Z") / 1000),
  });
}

const MORNING: Busy = { start: "2026-09-01T09:00:00Z", end: "2026-09-01T10:00:00Z" };
const AFTERNOON: Busy = { start: "2026-09-01T14:00:00Z", end: "2026-09-01T15:00:00Z" };

beforeEach(() => {
  vi.resetModules();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("which calendars a free/busy read covers", () => {
  it("falls back to the main calendar when the list is off limits", async () => {
    // Founders and advisors are no longer asked for the permission that lists
    // an account's calendars, so this 403 is the normal path for most people
    // now — not an error state. It must produce a working read, because the
    // alternative is what happened before: the whole availability lookup threw
    // and the person showed up as "couldn't read calendar".
    const busy = await busyFor({
      list: "denied",
      freeBusy: { primary: { busy: [AFTERNOON] } },
    });

    expect(askedFor).toEqual(["primary"]);
    expect(busy).toHaveLength(1);
  });

  it("reads every calendar when the list is available", async () => {
    // Session leads still grant the list scope. Their second work calendar
    // sitting there full of meetings while the grid calls them free is the
    // failure this covers.
    await busyFor({
      list: ["primary", "work@example.com"],
      freeBusy: {
        primary: { busy: [MORNING] },
        "work@example.com": { busy: [AFTERNOON] },
      },
    });

    expect(askedFor).toEqual(["primary", "work@example.com"]);
  });

  it("reads the main calendar when the account lists none", async () => {
    // An empty list used to return zero busy intervals, which reads as
    // "free all week" rather than "we found nothing to ask about".
    await busyFor({ list: [], freeBusy: { primary: { busy: [] } } });
    expect(askedFor).toEqual(["primary"]);
  });
});

describe("a calendar that can't be read", () => {
  it("is not counted as free", async () => {
    // Google reports a per-calendar failure INSIDE a 200 response, with `busy`
    // simply absent. Reading only `busy` turned a calendar we could not see
    // into a calendar with nothing on it. Here the only calendar fails, so the
    // honest answer is that we know nothing — and nothing must not be served
    // as an open day.
    await expect(
      busyFor({
        list: "denied",
        freeBusy: { primary: { errors: [{ reason: "notFound" }] } },
      })
    ).rejects.toThrow(/no readable calendars/i);
  });

  it("does not take the rest of the account down with it", async () => {
    // The other side of the same coin. A stale subscription whose owner
    // withdrew it should not make its owner unbookable — we still know when
    // they're busy on the calendars we could read.
    const busy = await busyFor({
      list: ["primary", "dead-subscription@example.com"],
      freeBusy: {
        primary: { busy: [MORNING] },
        "dead-subscription@example.com": { errors: [{ reason: "notFound" }] },
      },
    });

    expect(busy).toHaveLength(1);
    expect(busy[0].start).toBe(Math.floor(Date.parse(MORNING.start) / 1000));
  });
});
