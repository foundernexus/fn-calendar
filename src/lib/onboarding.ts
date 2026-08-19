import type { MemberCalendar, MemberWithConnection } from "@/db/queries";

/** A line of explanation. The object form is a labelled paragraph — used where
 * the text is really defining terms (the three roles, mostly) and running them
 * together as prose made them impossible to scan. */
export type StepDetail = string | { term: string; text: string };

/** One entry in the setup guide.
 *
 * `task` is something the person does, and it carries a `done` computed from
 * real data rather than from "have they clicked this". A checklist that ticks
 * itself when you read it teaches people to distrust it.
 *
 * `info` is an explanation with nothing to tick. The multi-calendar rules are
 * the clearest case: knowing that every calendar is READ but only one is
 * WRITTEN to isn't a step, it's the thing you have to understand before the
 * radio button makes any sense. Info steps never count towards progress. */
export type OnboardingStep = {
  id: string;
  title: string;
  /** Shown in the collapsed list, under the title. One line. */
  summary: string;
  detail: StepDetail[];
  kind: "task" | "info";
  done?: boolean;
  /** Worth doing, but doesn't hold the guide open — most people have one
   * calendar and are entirely finished without ever adding a second. */
  optional?: boolean;
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
      title: "Connect your calendar",
      summary: "So we can tell when you're actually free.",
      detail: [
        "Everything else here depends on this one. Your calendar is read for busy times, so a meeting already in your diary blocks that slot automatically — nobody can book over it.",
        "We read when you're busy and write FounderNexus sessions. Not your email, not your files, not your contacts.",
        "If a calendar ever stops working — you changed your password, or revoked access — it shows up here marked “Reconnect” rather than quietly going unchecked.",
      ],
    },
    {
      id: "set-availability",
      kind: "task",
      done: hasSavedAvailability,
      title: "Set your availability",
      summary: "The hours you're open to sessions at all.",
      detail: [
        "Start with your timezone. Every time on this page is stored against it, so getting it wrong shifts your whole week.",
        "The switch beside each day turns it on or off; the dropdowns set the hours. Think of these as the outer bounds rather than a promise you're free — your calendar is still checked on top of them.",
        {
          term: "Several blocks a day:",
          text: "“+ Add block” splits a day, so 9:00–12:00 and 14:00–17:00 keeps lunch clear. Up to three blocks per day, and they can't overlap.",
        },
        "Turning every day off is allowed and sometimes right — but it removes you from every search until you turn one back on, so the page warns you before you save it.",
      ],
    },
    {
      id: "second-calendar",
      kind: "task",
      optional: true,
      done: working.length > 1,
      title: "Add a second calendar",
      summary: "If work and private live in different places.",
      detail: [
        "You can connect more than one, and they don't have to match: Google for work and Microsoft for private is the usual reason people do this.",
        "Every calendar you add is checked for conflicts. You're only offered a time when you're free in all of them at once — which is the whole point, because it means a private appointment can't be booked over by someone who can't see it.",
        "Add one from the “Your calendars” card. Each address gets its own row, and you can remove any of them later as long as one is left.",
      ],
    },
    {
      id: "invite-target",
      kind: "info",
      title: "Where sessions get added",
      summary: "Every calendar is read. Exactly one is written to.",
      detail: [
        "Beside each address is a radio button marked “Add sessions here”. That's the calendar a booked session actually lands in.",
        "Only one can hold it, and that's deliberate. Writing the session to all of them would put the same meeting in your diary two or three times, as separate entries that then cancel independently of each other — leaving ghost meetings behind after a session moves.",
        "So the two halves are on purpose: connecting a calendar protects you from being double-booked, picking one decides where the invite shows up.",
      ],
    },
  ];

  if (isAdvisor) {
    steps.push({
      id: "sessions-tab",
      kind: "info",
      title: "Your sessions",
      summary: "Everything you've been booked into.",
      detail: [
        "The Sessions tab lists what's been booked with you, soonest first, with who's attending.",
        "The invite lands in your calendar as well — the tab exists so you can see the whole picture at once instead of reconstructing it from your diary.",
      ],
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
      summary: "Founders, advisors and team, from the People page.",
      detail: [
        "“Add person” registers someone so the sign-in page recognises their email. There's no automatic invite mail — you get a link and pass it on yourself, however you normally talk to them.",
        { term: "Founder", text: "— scheduled into sessions as a participant. The default." },
        {
          term: "Advisor",
          text: "— gets their own dashboard, and is picked from the Advisor field when booking rather than from the founder list.",
        },
        {
          term: "Team",
          text: "— FounderNexus staff who run sessions, and can be picked as the session lead.",
        },
        "Team also hands over the admin area, Schedule and People included, which is why only an account owner can grant it.",
      ],
    },
    {
      id: "get-connected",
      kind: "task",
      done: people.some((p) => p.connected),
      title: "Get their calendars connected",
      summary: "Added and connected are not the same thing.",
      detail: [
        "Until someone signs in and connects a calendar, there's no way to know when they're free — so they stay out of every picker and can't be booked at all.",
        "The People page shows exactly who's still pending, grouped by role, so you can chase the right ones instead of guessing. The link to send them is on that page.",
        "Warn them about one thing in advance: Google shows a screen naming “nylas.com” and says the app isn't verified. That's expected, and the sign-in page explains it — but people who weren't told tend to stop there.",
      ],
    },
    {
      id: "booking",
      kind: "info",
      title: "Booking a session",
      summary: "Pick who's in it, then a time that suits all of them.",
      detail: [
        "On Schedule you choose the founders, optionally an advisor, and a session lead. The grid then shows only slots where every single person involved is free.",
        "A grey cell doesn't only mean someone's outside their working hours — it also greys out when one participant has a conflict in their own calendar. Adding more people to a session will always leave fewer slots, never more.",
        "Booking creates the calendar invite for everyone at once, and cancelling from the grid removes it everywhere. You don't need to tidy up in anyone's calendar afterwards.",
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
    /** Drives whether the guide starts open. Optional tasks are excluded on
     * purpose: one calendar is a complete, finished setup. */
    allRequiredDone: required.every((s) => s.done),
  };
}
