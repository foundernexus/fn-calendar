import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/env", () => ({
  env: {
    GOOGLE_CLIENT_ID: "test-client-id",
    GOOGLE_CLIENT_SECRET: "test-secret",
    APP_URL: "https://scheduler.example.com",
  },
}));

beforeEach(() => {
  vi.resetModules();
});

async function authUrl(access: "read" | "write") {
  const { buildGoogleAuthUrl } = await import("@/lib/calendar/google");
  return new URL(buildGoogleAuthUrl({ state: "state-token", access }));
}

describe("the Google consent URL", () => {
  it("never sets include_granted_scopes", async () => {
    // Incremental authorisation hands back a token covering every scope the
    // account ever granted. With it on, narrowing the scope list changes what
    // the consent screen SAYS and not what the token can do, and a person who
    // unticks a permission still gets a token carrying it — which would make
    // the capability check in the callback impossible to fail.
    const url = await authUrl("read");
    expect(url.searchParams.get("include_granted_scopes")).toBeNull();
  });

  it("asks for consent every time, or Google issues no refresh token", async () => {
    // Google only returns a refresh token on a FIRST authorisation. Without
    // prompt=consent a reconnect yields an access token good for an hour and
    // nothing to renew it with, and the calendar goes quiet that afternoon.
    const url = await authUrl("read");
    expect(url.searchParams.get("prompt")).toBe("consent");
    expect(url.searchParams.get("access_type")).toBe("offline");
  });

  it("puts only the narrow read scopes in front of a founder or advisor", async () => {
    const scopes = (await authUrl("read")).searchParams.get("scope")!.split(" ");
    expect(scopes).toContain("https://www.googleapis.com/auth/calendar.freebusy");
    expect(scopes).toContain("https://www.googleapis.com/auth/calendar.calendarlist.readonly");
    expect(scopes).not.toContain("https://www.googleapis.com/auth/calendar.readonly");
    expect(scopes).not.toContain("https://www.googleapis.com/auth/calendar.events");
  });

  it("adds write for a session lead, whose calendar hosts the session", async () => {
    const scopes = (await authUrl("write")).searchParams.get("scope")!.split(" ");
    expect(scopes).toContain("https://www.googleapis.com/auth/calendar.events");
    expect(scopes).not.toContain("https://www.googleapis.com/auth/calendar.readonly");
  });
});
