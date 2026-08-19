import { describe, it, expect } from "vitest";
import { buildMemberSteps, buildAdminSteps, guideProgress } from "@/lib/onboarding";
import type { MemberCalendar, MemberWithConnection } from "@/db/queries";

/** The guide's only real claim is that a tick means the thing is actually
 * done. These cover the places where that could quietly stop being true. */

function calendar(over: Partial<MemberCalendar> = {}): MemberCalendar {
  return {
    id: 1,
    provider: "google",
    grantEmail: "a@example.com",
    isInviteTarget: true,
    needsReconnect: false,
    ...over,
  };
}

function person(over: Partial<MemberWithConnection> = {}): MemberWithConnection {
  return {
    id: 1,
    email: "a@example.com",
    fullName: "A Person",
    connected: false,
    needsReconnect: false,
    isFacilitator: false,
    isAdvisor: false,
    provider: null,
    grantEmail: null,
    connections: [],
    ...over,
  };
}

function step(steps: ReturnType<typeof buildMemberSteps>, id: string) {
  const found = steps.find((s) => s.id === id);
  if (!found) throw new Error(`no step ${id}`);
  return found;
}

describe("member steps", () => {
  it("doesn't count a broken calendar as connected", () => {
    const steps = buildMemberSteps({
      calendars: [calendar({ needsReconnect: true })],
      hasSavedAvailability: true,
      isAdvisor: false,
    });
    // A row exists, so a naive length check would tick this — but that member
    // is being checked by nothing at all, which is the exact situation the
    // step is there to catch.
    expect(step(steps, "connect-calendar").done).toBe(false);
  });

  it("counts them as connected when one of two works", () => {
    const steps = buildMemberSteps({
      calendars: [calendar({ id: 1, needsReconnect: true }), calendar({ id: 2 })],
      hasSavedAvailability: true,
      isAdvisor: false,
    });
    expect(step(steps, "connect-calendar").done).toBe(true);
    // Only one is usable, so "add a second" is genuinely still outstanding.
    expect(step(steps, "second-calendar").done).toBe(false);
  });

  it("ticks availability for someone who switched every day off", () => {
    // No availability rows, but they saved the form on purpose. Keying this to
    // "has rows" would nag them forever to set an availability they already
    // set — and the only way to satisfy it would be to undo their choice.
    const steps = buildMemberSteps({
      calendars: [calendar()],
      hasSavedAvailability: true,
      isAdvisor: false,
    });
    expect(step(steps, "set-availability").done).toBe(true);
  });

  it("leaves availability open for someone who never saved", () => {
    const steps = buildMemberSteps({
      calendars: [calendar()],
      hasSavedAvailability: false,
      isAdvisor: false,
    });
    expect(step(steps, "set-availability").done).toBe(false);
  });

  it("gives advisors the sessions step and founders not", () => {
    const advisor = buildMemberSteps({
      calendars: [calendar()],
      hasSavedAvailability: true,
      isAdvisor: true,
    });
    const founder = buildMemberSteps({
      calendars: [calendar()],
      hasSavedAvailability: true,
      isAdvisor: false,
    });
    expect(advisor.some((s) => s.id === "sessions-tab")).toBe(true);
    expect(founder.some((s) => s.id === "sessions-tab")).toBe(false);
  });
});

describe("progress", () => {
  it("treats one calendar as a finished setup", () => {
    const steps = buildMemberSteps({
      calendars: [calendar()],
      hasSavedAvailability: true,
      isAdvisor: false,
    });
    // Most people will never add a second calendar. If that optional step held
    // the guide open, it would sit there permanently accusing a member who has
    // done everything asked of them.
    expect(guideProgress(steps).allRequiredDone).toBe(true);
  });

  it("stays open while a required task is outstanding", () => {
    const steps = buildMemberSteps({
      calendars: [calendar()],
      hasSavedAvailability: false,
      isAdvisor: false,
    });
    expect(guideProgress(steps).allRequiredDone).toBe(false);
  });

  it("counts tasks only, never the explanations", () => {
    const steps = buildMemberSteps({
      calendars: [calendar()],
      hasSavedAvailability: true,
      isAdvisor: true,
    });
    const infoCount = steps.filter((s) => s.kind === "info").length;
    expect(infoCount).toBeGreaterThan(0);
    // Info steps can never be completed, so counting them would pin the guide
    // below 100% forever.
    expect(guideProgress(steps).total).toBe(steps.length - infoCount);
  });
});

describe("admin steps", () => {
  it("separates having added people from their being connected", () => {
    const steps = buildAdminSteps({ people: [person(), person({ id: 2 })] });
    const byId = (id: string) => steps.find((s) => s.id === id)!;
    // This is the distinction the whole People page exists to make visible —
    // two registered people, nobody bookable.
    expect(byId("add-people").done).toBe(true);
    expect(byId("get-connected").done).toBe(false);
  });

  it("ticks connected once anyone actually is", () => {
    const steps = buildAdminSteps({ people: [person(), person({ id: 2, connected: true })] });
    expect(steps.find((s) => s.id === "get-connected")!.done).toBe(true);
  });

  it("starts a brand new workspace with everything outstanding", () => {
    const steps = buildAdminSteps({ people: [] });
    expect(guideProgress(steps).done).toBe(0);
    expect(guideProgress(steps).allRequiredDone).toBe(false);
  });
});
