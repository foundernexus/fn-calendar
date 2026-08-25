import { describe, it, expect, vi, afterEach } from "vitest";
import { updateContact } from "@/lib/hubspot";

/** How a field gets emptied.
 *
 * HubSpot answers 200 to a write it has decided to ignore, so this is not
 * something a caller can notice at runtime. A cancelled 1:1 kept its date for
 * days because of it: rescheduling sent a real value and worked, cancelling
 * sent a JSON null and silently did nothing. */

function stubFetch() {
  const calls: { url: string; body: unknown }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)) });
      return { ok: true, json: async () => ({}) } as Response;
    })
  );
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("clearing a property", () => {
  it("sends an empty string, never null", async () => {
    const calls = stubFetch();
    await updateContact("123", {
      fn_next_monthly_11: null,
      fn_last_monthly_11: null,
      fn_11_booked_through: null,
    });

    const { properties } = calls[0].body as { properties: Record<string, unknown> };
    expect(properties.fn_next_monthly_11).toBe("");
    expect(properties.fn_last_monthly_11).toBe("");
    expect(properties.fn_11_booked_through).toBe("");
  });

  it("leaves real values alone", async () => {
    const calls = stubFetch();
    await updateContact("123", {
      fn_next_monthly_11: "2026-08-28",
      fn_last_monthly_11: null,
    });

    const { properties } = calls[0].body as { properties: Record<string, unknown> };
    expect(properties.fn_next_monthly_11).toBe("2026-08-28");
    expect(properties.fn_last_monthly_11).toBe("");
  });

  it("says nothing about fields it wasn't given", async () => {
    // A partial write must stay partial. Sending every known field on every
    // call would blank whatever this particular update had no opinion about.
    const calls = stubFetch();
    await updateContact("123", { fn_next_monthly_11: "2026-08-28" });

    const { properties } = calls[0].body as { properties: Record<string, unknown> };
    expect(Object.keys(properties)).toEqual(["fn_next_monthly_11"]);
  });
});
