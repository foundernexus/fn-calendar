import { getAccessToken } from "@/lib/calendar/tokens";
import { createEvent, updateEvent, deleteEvent, asCalendarProvider } from "@/lib/calendar";

/** Booking, moving and cancelling a session on the organiser's calendar.
 *
 * Thin on purpose: the interesting decisions live elsewhere. What this adds is
 * that every call resolves a fresh access token first, so no route has to
 * remember to — forgetting would mean sending an hour-old token and reading
 * back a 401 that says nothing about the real cause.
 *
 * The session is created on the ORGANISER's calendar with everyone else as
 * attendees. That's the same model as before and it's what makes this whole
 * migration cheap: participants are invited by email address, so we never need
 * write access to a founder's calendar — only to the session lead's. */
export type EventConnection = {
  id: number;
  provider: string;
  /** The address this calendar was connected under — the organiser's, since the
   * event is created on this calendar. connectionCredentials already returns
   * it; it was simply never declared here. */
  grantEmail: string;
  refreshTokenEncrypted: string | null;
  accessTokenEncrypted: string | null;
  accessTokenExpiresAt: Date | null;
};

export async function createSessionEvent(params: {
  connection: EventConnection;
  title: string;
  description?: string;
  meetingUrl?: string;
  startTime: number;
  endTime: number;
  timezone: string;
  participants: { name?: string; email: string }[];
}) {
  const accessToken = await getAccessToken(params.connection);
  return createEvent({
    provider: asCalendarProvider(params.connection.provider),
    accessToken,
    title: params.title,
    description: params.description,
    meetingUrl: params.meetingUrl,
    startTime: params.startTime,
    endTime: params.endTime,
    timezone: params.timezone,
    participants: params.participants,
    // The event is created ON this connection's calendar, so its address IS
    // the organiser's. Passed down so the provider can be told that person has
    // already agreed to be there — see createGoogleEvent.
    organizerEmail: params.connection.grantEmail,
  });
}

/** Moves an existing session, keeping the same event and the same attendees.
 *
 * Deliberately not "cancel and recreate": providers send attendees an update
 * for a moved event rather than a cancellation followed by a fresh invite, so
 * it stays one entry in their calendar, keeps whatever they had already
 * answered, and doesn't read as "that session is off" to anyone skimming their
 * inbox. */
export async function moveSessionEvent(params: {
  connection: EventConnection;
  providerEventId: string;
  startTime: number;
  endTime: number;
  timezone: string;
}) {
  const accessToken = await getAccessToken(params.connection);
  return updateEvent({
    provider: asCalendarProvider(params.connection.provider),
    accessToken,
    eventId: params.providerEventId,
    startTime: params.startTime,
    endTime: params.endTime,
    timezone: params.timezone,
  });
}

/** Deletes the session from the organiser's calendar. Because every attendee
 * was invited as a participant, the provider withdraws it from their calendars
 * too and sends its own cancellation notice — there is no separate "notify"
 * step, and no way to cancel quietly. */
export async function cancelSessionEvent(params: {
  connection: EventConnection;
  providerEventId: string;
}) {
  const accessToken = await getAccessToken(params.connection);
  return deleteEvent({
    provider: asCalendarProvider(params.connection.provider),
    accessToken,
    eventId: params.providerEventId,
  });
}
