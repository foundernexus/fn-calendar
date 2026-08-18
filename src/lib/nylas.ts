import Nylas, { AvailabilityMethod } from "nylas";
import { env } from "@/lib/env";

// Lazy for the same reason as src/db/index.ts — env vars are blank until the
// user pastes in real Nylas credentials, and this module may get pulled into
// Next's build-time module graph before that happens.
let _nylas: Nylas | undefined;

function getNylas() {
  if (!_nylas) {
    _nylas = new Nylas({ apiKey: env.NYLAS_API_KEY, apiUri: env.NYLAS_API_URI });
  }
  return _nylas;
}

/** The calendar providers /connect offers. Both are configured as connectors
 * on the production Nylas app; anything else would fail at the token exchange. */
export const CALENDAR_PROVIDERS = ["google", "microsoft"] as const;
export type CalendarProvider = (typeof CALENDAR_PROVIDERS)[number];

/** Narrows a stored `calendar_connections.provider` back to something we can
 * re-authenticate against. That column is free text straight from Nylas, so it
 * can hold values we no longer offer (e.g. "icloud" from an older connector,
 * or "unknown" when the exchange didn't report one). Falling back to google
 * keeps a reconnect working rather than 500-ing on a stale row. */
export function asCalendarProvider(value: string | null | undefined): CalendarProvider {
  return CALENDAR_PROVIDERS.includes(value as CalendarProvider)
    ? (value as CalendarProvider)
    : "google";
}

/**
 * Builds the Nylas Hosted Auth URL for a specific provider.
 *
 * `provider` is always passed, never omitted. Leaving it unset routes members
 * through Nylas's own hosted login screen first, which carries the Nylas logo
 * and cannot be rebranded without upgrading to an annual Nylas contract
 * (dashboard → Hosted authentication → Branding: the toggle is locked).
 * Naming the provider skips that screen entirely and goes straight to
 * Google/Microsoft — so we render our own two buttons on /connect instead,
 * and founders never see a vendor's logo on the way into FounderNexus's tool.
 */
export function buildHostedAuthUrl(params: {
  loginHint: string;
  state: string;
  provider: CalendarProvider;
}) {
  return getNylas().auth.urlForOAuth2({
    clientId: env.NYLAS_CLIENT_ID,
    redirectUri: env.NYLAS_CALLBACK_URI,
    provider: params.provider,
    loginHint: params.loginHint,
    state: params.state,
  });
}

/** Exchanges the OAuth callback `code` for a grant. Returns grantId/email/provider
 * — never store the accessToken, we only need the grant. */
export function exchangeNylasCode(code: string) {
  return getNylas().auth.exchangeCodeForToken({
    clientId: env.NYLAS_CLIENT_ID,
    redirectUri: env.NYLAS_CALLBACK_URI,
    code,
  });
}

export type AvailabilitySlot = {
  emails: string[];
  startTime: number;
  endTime: number;
};

/** Collective availability: every participant must be free. Only ever returns
 * free/busy time slots — never event content — so this is privacy-safe by
 * construction; don't add a different Nylas calendar/events call against a
 * member's own grant elsewhere in the app.
 *
 * IMPORTANT for the caller (Step 4): `participantEmails` must be each member's
 * connected calendar's `grant_email` (from `calendar_connections`), NOT their
 * registered `members.email` — a member's registered email and the calendar
 * account they actually connected can differ (e.g. a personal Gmail), and
 * Nylas resolves availability against the grant, so passing the wrong email
 * will silently return no/incorrect availability for that member. */
export async function getCollectiveAvailability(params: {
  participantEmails: string[];
  startTime: number;
  endTime: number;
  durationMinutes: number;
  intervalMinutes?: number;
  timezone: string;
  workingHoursStart: string;
  workingHoursEnd: string;
  excludeWeekends: boolean;
}): Promise<AvailabilitySlot[]> {
  const days = params.excludeWeekends
    ? [1, 2, 3, 4, 5]
    : [0, 1, 2, 3, 4, 5, 6];

  const res = await getNylas().calendars.getAvailability({
    requestBody: {
      participants: params.participantEmails.map((email) => ({
        email,
        calendarIds: ["primary"],
      })),
      startTime: params.startTime,
      endTime: params.endTime,
      durationMinutes: params.durationMinutes,
      intervalMinutes: params.intervalMinutes ?? 30,
      // Must match intervalMinutes, not a finer-grained value — the grid
      // (src/components/availability-grid.tsx) generates its rows by
      // stepping from workingHoursStart in intervalMinutes increments, so a
      // returned slot rounded to a finer boundary (e.g. 15 min against a
      // 30-min grid) can land between rows and silently fail to render.
      roundTo: params.intervalMinutes ?? 30,
      availabilityRules: {
        availabilityMethod: AvailabilityMethod.Collective,
        buffer: { before: 0, after: 0 },
        defaultOpenHours: [
          {
            days,
            timezone: params.timezone,
            start: params.workingHoursStart,
            end: params.workingHoursEnd,
            exdates: [],
          },
        ],
      },
    },
  });

  // The SDK types TimeSlot.startTime/endTime as `string` even though they're
  // unix-second timestamps — coerce defensively.
  return res.data.timeSlots.map((slot) => ({
    emails: slot.emails,
    startTime: Number(slot.startTime),
    endTime: Number(slot.endTime),
  }));
}

/** Creates the real calendar event on the organizer's grant with every selected
 * member as a participant, and (with notifyParticipants) triggers real invite
 * emails immediately — there is no dry-run mode. */
export async function createNylasEvent(params: {
  organizerGrantId: string;
  title: string;
  description?: string;
  meetingUrl?: string;
  startTime: number;
  endTime: number;
  timezone: string;
  participants: { name?: string; email: string }[];
  calendarId?: string;
}) {
  return getNylas().events.create({
    identifier: params.organizerGrantId,
    requestBody: {
      title: params.title,
      description: params.description,
      // `location` (not a typed Zoom/Meet `conferencing` object) since this
      // is an arbitrary admin-pasted URL of unknown provider — location
      // reliably shows on the invite regardless of provider.
      location: params.meetingUrl,
      when: {
        startTime: params.startTime,
        endTime: params.endTime,
        startTimezone: params.timezone,
        endTimezone: params.timezone,
      },
      participants: params.participants.map((p) => ({
        email: p.email,
        name: p.name,
        status: "noreply",
      })),
    },
    queryParams: {
      calendarId: params.calendarId ?? "primary",
      notifyParticipants: true,
    },
  });
}
