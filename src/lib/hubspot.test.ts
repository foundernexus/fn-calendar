import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";

/** Getting a value into a HubSpot property in the shape that property wants.
 *
 * Two separate afternoons went into this file's two rules, and neither failure
 * announced itself — HubSpot answered 200 both times:
 *
 *  - a JSON null is ignored, so a cancelled 1:1 kept its date;
 *  - a date-only string in a Date-and-time property is read as midnight UTC,
 *    which in Pacific is five o'clock the previous afternoon, so a session
 *    booked on the 31st showed up as the 30th. */

/** @param types what the fake HubSpot reports for the property batch read. */
function stubFetch(types: Record<string, string> = {}) {
  const calls: { url: string; body: unknown }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)) });
      if (String(url).includes("/properties/")) {
        return {
          ok: true,
          json: async () => ({
            results: Object.entries(types).map(([name, type]) => ({ name, type })),
          }),
        } as Response;
      }
      return { ok: true, json: async () => ({}) } as Response;
    })
  );
  return calls;
}

/** The PATCH, ignoring the property-type lookup that precedes it. */
function written(calls: { url: string; body: unknown }[]) {
  const patch = calls.find((c) => !c.url.includes("/properties/"));
  return (patch!.body as { properties: Record<string, unknown> }).properties;
}

const AUG_31 = { iso: "2026-08-31T21:30:00.000Z", localDate: "2026-08-31" };

/** The property-type cache lives for the life of the process, which is right in
 * production and wrong inside one test file — the first test's answer would
 * decide every later one. */
beforeEach(() => {
  vi.resetModules();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

async function updateContact(...args: Parameters<typeof import("@/lib/hubspot").updateContact>) {
  const mod = await import("@/lib/hubspot");
  return mod.updateContact(...args);
}

describe("clearing a property", () => {
  it("sends an empty string, never null", async () => {
    const calls = stubFetch();
    await updateContact("123", {
      fn_next_monthly_11: null,
      fn_last_monthly_11: null,
      fn_11_booked_through: null,
    });

    const properties = written(calls);
    expect(properties.fn_next_monthly_11).toBe("");
    expect(properties.fn_last_monthly_11).toBe("");
    expect(properties.fn_11_booked_through).toBe("");
  });

  it("says nothing about fields it wasn't given", async () => {
    // A partial write must stay partial. Sending every known field on every
    // call would blank whatever this particular update had no opinion about.
    const calls = stubFetch();
    await updateContact("123", { fn_next_monthly_11: AUG_31 });
    expect(Object.keys(written(calls))).toEqual(["fn_next_monthly_11"]);
  });
});

describe("matching the property's own type", () => {
  it("sends a full timestamp to a Date-and-time property", async () => {
    // THE bug. Sending "2026-08-31" here is read as midnight UTC and displays
    // as 30 August, 5pm to anyone in Pacific.
    const calls = stubFetch({ fn_next_monthly_11: "datetime" });
    await updateContact("123", { fn_next_monthly_11: AUG_31 });
    expect(written(calls).fn_next_monthly_11).toBe("2026-08-31T21:30:00.000Z");
  });

  it("sends the calendar date to a text property", async () => {
    // Nobody wants a full ISO timestamp sitting in a text column.
    const calls = stubFetch({ fn_last_monthly_11: "string" });
    await updateContact("123", { fn_last_monthly_11: AUG_31 });
    expect(written(calls).fn_last_monthly_11).toBe("2026-08-31");
  });

  it("sends the calendar date to a Date property", async () => {
    const calls = stubFetch({ fn_next_monthly_11: "date" });
    await updateContact("123", { fn_next_monthly_11: AUG_31 });
    expect(written(calls).fn_next_monthly_11).toBe("2026-08-31");
  });

  it("falls back to the date when the types can't be read", async () => {
    // Not being able to ask is not a reason to fail the write. This is what the
    // code did before it asked at all, so an outage over there costs the
    // precision and nothing else.
    const calls = stubFetch();
    await updateContact("123", { fn_next_monthly_11: AUG_31 });
    expect(written(calls).fn_next_monthly_11).toBe("2026-08-31");
  });

  it("uses the SESSION's calendar date, not the UTC one", async () => {
    // A 17:00 Pacific session is already tomorrow in UTC. Slicing the timestamp
    // would report every late-afternoon 1:1 a day late — the same off-by-one
    // from the other direction.
    const calls = stubFetch({ fn_next_monthly_11: "date" });
    await updateContact("123", {
      fn_next_monthly_11: { iso: "2026-09-01T00:30:00.000Z", localDate: "2026-08-31" },
    });
    expect(written(calls).fn_next_monthly_11).toBe("2026-08-31");
  });
});
