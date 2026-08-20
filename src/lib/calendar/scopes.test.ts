import { describe, it, expect } from "vitest";
import { requestedScopes, missingCapabilities } from "@/lib/calendar/scopes";

describe("what we ask for", () => {
  it("never asks a founder or advisor for write access", () => {
    // The whole point of the change: a session is created on the organiser's
    // calendar and everyone else is invited by email, so write access from an
    // attendee is something we would ask for and never use.
    expect(requestedScopes("google", "read")).not.toContain(
      "https://www.googleapis.com/auth/calendar.events"
    );
    expect(requestedScopes("microsoft", "read")).not.toContain("Calendars.ReadWrite");
  });

  it("never asks anyone to read what their meetings actually are", () => {
    // calendar.readonly is the scope that reads titles, attendees and notes.
    // It should appear in no tier at all now.
    for (const access of ["read", "write"] as const) {
      expect(requestedScopes("google", access)).not.toContain(
        "https://www.googleapis.com/auth/calendar.readonly"
      );
    }
  });

  it("still asks a session lead for write access", () => {
    expect(requestedScopes("google", "write")).toContain(
      "https://www.googleapis.com/auth/calendar.events"
    );
    expect(requestedScopes("microsoft", "write")).toContain("Calendars.ReadWrite");
  });

  it("keeps offline_access, or Microsoft returns no refresh token at all", () => {
    expect(requestedScopes("microsoft", "read")).toContain("offline_access");
  });
});

describe("what we check we got", () => {
  it("accepts exactly what we asked for", () => {
    for (const provider of ["google", "microsoft"] as const) {
      for (const access of ["read", "write"] as const) {
        expect(missingCapabilities(provider, access, requestedScopes(provider, access))).toEqual([]);
      }
    }
  });

  it("names the capability, not the scope URL", () => {
    // This string is shown to whoever just clicked through the consent screen.
    // A scope URL would tell them nothing about which checkbox to leave ticked.
    const missing = missingCapabilities("google", "read", [
      "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
    ]);
    expect(missing).toEqual(["see when you're busy"]);
  });

  it("rejects Calendars.ReadBasic, which cannot actually read free/busy", () => {
    // Microsoft documents it as the least-privileged permission for
    // getSchedule. A personal Outlook account holding exactly that scope got
    // 403 ErrorAccessDenied from the endpoint. A token that can't do the job
    // has to fail here and prompt a reconnect rather than be accepted.
    expect(missingCapabilities("microsoft", "read", ["Calendars.ReadBasic"])).toEqual([
      "see when you're busy",
    ]);
    expect(requestedScopes("microsoft", "read")).not.toContain("Calendars.ReadBasic");
    expect(requestedScopes("microsoft", "read")).toContain("Calendars.Read");
  });

  it("recognises Microsoft's fully-qualified scope form", () => {
    // Microsoft returns either `Calendars.Read` or
    // `https://graph.microsoft.com/Calendars.Read` for the same grant.
    // Comparing the raw strings would refuse a perfectly good connection.
    expect(
      missingCapabilities("microsoft", "read", ["https://graph.microsoft.com/Calendars.Read"])
    ).toEqual([]);
  });

  it("accepts a broader scope than the one requested", () => {
    // Everyone connected before this change holds calendar.readonly, which
    // covers both narrow scopes. Their tokens must keep working.
    expect(
      missingCapabilities("google", "read", ["https://www.googleapis.com/auth/calendar.readonly"])
    ).toEqual([]);
    expect(missingCapabilities("microsoft", "read", ["Calendars.ReadWrite"])).toEqual([]);
  });

  it("does not accept read access where write is required", () => {
    expect(missingCapabilities("microsoft", "write", ["Calendars.Read"])).toEqual([
      "add sessions to your calendar",
    ]);
  });

  it("is case-insensitive", () => {
    expect(missingCapabilities("microsoft", "read", ["calendars.read"])).toEqual([]);
  });

  it("treats an absent scope list as unknown rather than as a refusal", () => {
    expect(missingCapabilities("google", "write", undefined)).toEqual([]);
    expect(missingCapabilities("google", "write", [])).toEqual([]);
  });
});
