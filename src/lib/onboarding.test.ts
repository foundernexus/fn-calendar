import { describe, it, expect } from "vitest";
import { buildMemberSteps, guideProgress } from "@/lib/onboarding";
import type { MemberCalendar } from "@/db/queries";

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

describe("the walkthrough sequence", () => {
  const tourSteps = () =>
    buildMemberSteps({
      calendars: [calendar()],
      hasSavedAvailability: false,
      isAdvisor: false,
    }).filter((s) => s.target);

  it("walks calendars, then availability, then Save", () => {
    // The order someone actually works in. Connecting is deliberately absent:
    // anyone seeing this page already connected to get here.
    expect(tourSteps().map((s) => s.id)).toEqual([
      "second-calendar",
      "set-availability",
      "save",
    ]);
  });

  it("never highlights the same box twice in a row", () => {
    // Two consecutive steps pointing at one card reads as though the tour lost
    // its place — which is why "where sessions get added" is checklist-only.
    const targets = tourSteps().map((s) => s.target);
    expect(new Set(targets).size).toBe(targets.length);
  });

  it("keeps the Save prompt out of the checklist", () => {
    // "Press Save" is a prompt for the moment. In a permanent list it would
    // sit there looking like unfinished work forever.
    const save = buildMemberSteps({
      calendars: [calendar()],
      hasSavedAvailability: true,
      isAdvisor: false,
    }).find((s) => s.id === "save");
    expect(save?.tourOnly).toBe(true);
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
