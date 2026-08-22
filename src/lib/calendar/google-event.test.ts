import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/env", () => ({
  env: {
    GOOGLE_CLIENT_ID: "test-client-id",
    GOOGLE_CLIENT_SECRET: "test-secret",
    APP_URL: "https://scheduler.example.com",
  },
}));

/** What we actually send Google when a session is booked. */

type Attendee = { email: string; displayName?: string; responseStatus?: string };
let sent: { url: string; body: { attendees: Attendee[] } };

beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      sent = { url: String(url), body: JSON.parse(String(init?.body)) };
      return new Response(JSON.stringify({ id: "evt-1", htmlLink: "https://cal" }), { status: 200 });
    })
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
});

async function create(organizerEmail?: string) {
  const { createGoogleEvent } = await import("@/lib/calendar/google");
  await createGoogleEvent({
    accessToken: "token",
    title: "Expert session",
    startTime: Math.floor(Date.parse("2026-09-02T17:00:00Z") / 1000),
    endTime: Math.floor(Date.parse("2026-09-02T18:00:00Z") / 1000),
    timezone: "America/Los_Angeles",
    participants: [
      { email: "Karin@FounderNexus.com", name: "Karin" },
      { email: "founder@example.com", name: "Yuan" },
    ],
    organizerEmail,
  });
  return sent;
}

describe("creating a session on Google", () => {
  it("marks the session lead as already accepted", async () => {
    // Without this Google defaults every attendee to needsAction, including the
    // person whose calendar the event was just created on. They then see, on
    // their own calendar, an invitation they appear not to have answered for a
    // meeting they are hosting — and no email ever arrives to prompt them,
    // because Google does not invite an organiser to their own event.
    const { body } = await create("karin@foundernexus.com");

    const lead = body.attendees.find((a) => a.email === "Karin@FounderNexus.com");
    expect(lead!.responseStatus).toBe("accepted");
  });

  it("compares the address case-insensitively", async () => {
    // grant_email and the participant list can disagree on case — the address
    // is stored as the provider returned it. Missing the match would silently
    // put the lead back on needsAction.
    const { body } = await create("KARIN@foundernexus.COM");
    expect(body.attendees.find((a) => a.email === "Karin@FounderNexus.com")!.responseStatus).toBe(
      "accepted"
    );
  });

  it("leaves everyone else to answer for themselves", async () => {
    const { body } = await create("karin@foundernexus.com");
    expect(body.attendees.find((a) => a.email === "founder@example.com")!.responseStatus).toBe(
      undefined
    );
  });

  it("still invites the lead rather than leaving them implied", async () => {
    // The bug this whole area was rebuilt around: a session lead who owned the
    // calendar but was not on the invite, so nothing showed them as attending
    // their own session.
    const { body } = await create("karin@foundernexus.com");
    expect(body.attendees).toHaveLength(2);
  });

  it("emails the invitations", async () => {
    // sendUpdates=all is the difference between an invitation and an event that
    // silently appears on one calendar.
    const { url } = await create("karin@foundernexus.com");
    expect(url).toContain("sendUpdates=all");
  });
});
