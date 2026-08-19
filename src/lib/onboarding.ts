import type { MemberCalendar, MemberWithConnection } from "@/db/queries";

/** One entry in the setup guide.
 *
 * `task` is something the person does, and it carries a `done` computed from
 * real data rather than from "have they clicked this". A checklist that ticks
 * itself when you read it teaches people to distrust it.
 *
 * `info` is an explanation with nothing to tick. That every calendar is READ
 * but only one is WRITTEN to isn't a step, it's the thing you have to
 * understand before the radio button makes any sense. Info steps never count
 * towards progress.
 *
 * `detail` is kept to a couple of short lines on purpose. Nobody opens a setup
 * panel to read; they open it to find out why something is there and then get
 * on with it, and a paragraph they skip explains less than one line they
 * actually finish. */
export type OnboardingStep = {
  id: string;
  title: string;
  /** Shown in the collapsed list, under the title. One line. */
  summary: string;
  detail: string[];
  kind: "task" | "info";
  done?: boolean;
  /** Worth doing, but doesn't hold the guide open — most people have one
   * calendar and are entirely finished without ever adding a second. */
  optional?: boolean;
  /** CSS selector for the thing on screen this step is about. Steps with one
   * are pointed at during the walkthrough; steps without are checklist-only.
   *
   * A selector rather than a ref because the checklist is built on the server
   * and the elements live in three different client components — passing refs
   * across that boundary would mean restructuring all of them to describe
   * something that is, in the end, "the box over there". */
  target?: string;
  /** Shown during the walkthrough but kept out of the checklist. For steps
   * that are a prompt in the moment rather than a thing to track — "press
   * Save" belongs beside the button while you're there, not in a permanent
   * list of outstanding work. */
  tourOnly?: boolean;
};

/** Founders and advisors. `/me` and the advisor panel run the same availability
 * form, so they get the same steps; the advisor's Sessions tab is the one
 * addition.
 *
 * `hasSavedAvailability` is the member's timezone being non-null. That's the
 * same signal `defaultDays()` in member-settings-form.tsx uses for "never
 * submitted this form", and it deliberately isn't "has availability rows": a
 * member who switched every day off has no rows either, and telling them to go
 * set an availability they already set on purpose would be wrong. */
export function buildMemberSteps({
  calendars,
  hasSavedAvailability,
  isAdvisor,
}: {
  calendars: MemberCalendar[];
  hasSavedAvailability: boolean;
  isAdvisor: boolean;
}): OnboardingStep[] {
  const working = calendars.filter((c) => !c.needsReconnect);

  const steps: OnboardingStep[] = [
    {
      id: "connect-calendar",
      kind: "task",
      done: working.length > 0,
      // Deliberately no `target`, so the walkthrough skips it: anyone seeing
      // this page connected a calendar to get here, and opening a tour by
      // pointing at something already done reads as though nobody checked.
      //
      // It stays in the checklist because it stops being a formality the
      // moment a connection breaks — that is when it turns into the reconnect
      // prompt, which is exactly what every member saw during the switch away
      // from Nylas.
      title: "Connect your calendar",
      summary: "So we can tell when you're actually free.",
      detail: [
        "We read your busy times, so nobody can book over something you already have.",
        "Calendar access only — nothing else is touched.",
      ],
    },
    // Ordered as the page is, top to bottom: calendars card, then the weekly
    // grid, then Save. A walkthrough that jumps up and down the page makes
    // people hunt for what moved, and the checklist reads the same way for the
    // same reason.
    {
      id: "second-calendar",
      kind: "task",
      optional: true,
      done: working.length > 1,
      target: '[data-tour="calendars"]',
      title: "Add a second calendar",
      summary: "If your time is split across two of them.",
      detail: [
        "Only if your time is split — work in one calendar, private in another. Every calendar you add is checked too, so a private appointment can't be booked over by someone who can't see it.",
        "They don't have to match: a Google and a Microsoft calendar can sit side by side.",
      ],
    },
    {
      id: "set-availability",
      kind: "task",
      done: hasSavedAvailability,
      target: '[data-tour="availability"]',
      title: "Set your availability",
      summary: "The hours you're open to sessions at all.",
      detail: [
        "These are the outer bounds. Your calendar is still checked on top of them.",
        "Use “+ Add block” to split a day and keep a break in the middle.",
        "It only counts once you press Save.",
      ],
    },
    {
      id: "invite-target",
      kind: "info",
      // No target: it would point at the same card as the second-calendar step
      // above, and a walkthrough that highlights the same box twice in a row
      // looks like it lost its place. The rule lives in the checklist, where
      // it can be reread at the moment it's actually needed.
      title: "Where sessions get added",
      summary: "All are read. One receives the invite.",
      detail: [
        "Pick it with the radio button beside the address.",
        "Only one, or the same session would land in your diary twice.",
      ],
    },
  ];

  // Last, and tour-only. The form arrives pre-filled with Mon–Fri 9–5, which
  // looks exactly like a saved setting and isn't one — someone who reads it,
  // agrees with it and closes the tab has stored nothing and stays unbookable.
  // That has already happened once here, to the account of the person who
  // built this. It belongs beside the button, in the moment, not in a
  // permanent checklist.
  steps.push({
    id: "save",
    kind: "info",
    tourOnly: true,
    target: '[data-tour="save"]',
    title: "Press Save",
    summary: "Nothing is stored until you do.",
    detail: [
      "The times above are only a suggestion until you save them — the form looks filled in from the start, which is exactly why this is easy to miss.",
    ],
  });

  if (isAdvisor) {
    steps.push({
      id: "sessions-tab",
      kind: "info",
      title: "Your sessions",
      summary: "Everything you've been booked into.",
      detail: ["One list, so you don't have to reconstruct it from your calendar."],
    });
  }

  return steps;
}

/** FounderNexus staff — both account owners and anyone marked Team. Driven off
 * the people list both admin pages already load, so the guide costs no extra
 * query. */
export function buildAdminSteps({ people }: { people: MemberWithConnection[] }): OnboardingStep[] {
  return [
    {
      id: "add-people",
      kind: "task",
      done: people.length > 0,
      title: "Add the people you schedule",
      summary: "Founders, advisors and team.",
      detail: [
        "Registers them so they can sign in. There's no automatic invite mail — you pass the link on yourself.",
        "Founders are scheduled into sessions, advisors get their own dashboard, and team can run sessions and see this admin area.",
      ],
    },
    {
      id: "get-connected",
      kind: "task",
      done: people.some((p) => p.connected),
      title: "Get their calendars connected",
      summary: "Added and connected aren't the same.",
      detail: [
        "Until someone connects a calendar there's no way to know when they're free, so they can't be booked at all.",
        "The People page shows who's still pending.",
      ],
    },
    {
      id: "booking",
      kind: "info",
      title: "Booking a session",
      summary: "Only times that suit everyone are offered.",
      detail: [
        "A grey cell can be someone's conflict, not just their working hours.",
        "Booking invites everyone at once; cancelling removes it everywhere.",
      ],
    },
  ];
}

/** Progress over tasks only — info steps have nothing to complete, and
 * counting them would leave the guide permanently stuck below 100%. */
export function guideProgress(steps: OnboardingStep[]) {
  const tasks = steps.filter((s) => s.kind === "task");
  const required = tasks.filter((s) => !s.optional);
  return {
    total: tasks.length,
    done: tasks.filter((s) => s.done).length,
    /** Only drives the header wording now that the panel opens on every
     * sign-in. Optional tasks are excluded on purpose: one calendar is a
     * complete, finished setup. */
    allRequiredDone: required.every((s) => s.done),
  };
}
