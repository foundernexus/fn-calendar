import { vi } from "vitest";
import { db } from "@/db";
import { members, calendarConnections, events, eventAttendees } from "@/db/schema";
import { encryptToken } from "@/lib/calendar/crypto";
import {
  signValue,
  TOKEN_PURPOSE,
  ADMIN_COOKIE_NAME,
  MEMBER_COOKIE_NAME,
} from "@/lib/auth/session";

/** Matches the value vitest.config.ts injects, and therefore what
 * isConnectionUsable compares against. A connection row created with anything
 * else is treated as belonging to a retired Nylas app — useful on purpose in
 * the tests that cover exactly that. */
export const TEST_CLIENT_ID = "test-nylas-client-id";
export const TEST_SECRET = "test-secret-at-least-32-characters-long";

/** On the ADMIN_EMAILS allowlist in vitest.config.ts — an owner. */
export const OWNER_EMAIL = "tobias@foundernexus.com";

/** Cookies are minted with the REAL signing code, not hand-rolled strings.
 * A test that fakes its own session proves the route works for tokens the
 * route would never see; this way the signature, the purpose tag and the
 * expiry are all exactly what production produces. */
export async function adminCookie(email = OWNER_EMAIL) {
  const token = await signValue(TOKEN_PURPOSE.adminSession, { email }, TEST_SECRET, 3600);
  return `${ADMIN_COOKIE_NAME}=${token}`;
}

export async function memberCookie(memberId: number) {
  const token = await signValue(TOKEN_PURPOSE.memberSession, { memberId }, TEST_SECRET, 3600);
  return `${MEMBER_COOKIE_NAME}=${token}`;
}

/** State token for the Nylas callback, in the same shape /api/connect/start
 * and /api/me/calendars produce. */
export async function connectState(payload: {
  memberId: number;
  redirectTo?: "admin";
  addCalendar?: boolean;
}) {
  return signValue(TOKEN_PURPOSE.connectState, payload, TEST_SECRET, 600);
}

export function jsonRequest(
  url: string,
  body: unknown,
  opts: { cookie?: string; method?: string } = {}
) {
  return new Request(url, {
    method: opts.method ?? "POST",
    headers: {
      "Content-Type": "application/json",
      ...(opts.cookie ? { cookie: opts.cookie } : {}),
    },
    body: JSON.stringify(body),
  });
}

/** next/headers reads cookies from an async-local store that only exists
 * inside a real request. Route handlers are called directly here, so the
 * store is stubbed from whatever cookie header the test set. */
export function mockCookies(cookieHeader?: string) {
  const jar = new Map<string, string>();
  for (const part of (cookieHeader ?? "").split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name) jar.set(name, rest.join("="));
  }
  vi.doMock("next/headers", () => ({
    cookies: async () => ({
      get: (name: string) => {
        const value = jar.get(name);
        return value === undefined ? undefined : { name, value };
      },
      set: () => {},
      delete: () => {},
    }),
  }));
}

// ---------------------------------------------------------------- seeding

export async function seedMember(over: {
  email: string;
  fullName?: string;
  isAdvisor?: boolean;
  isFacilitator?: boolean;
  timezone?: string | null;
}) {
  const [row] = await db
    .insert(members)
    .values({
      email: over.email,
      fullName: over.fullName ?? over.email,
      isAdvisor: over.isAdvisor ?? false,
      isFacilitator: over.isFacilitator ?? false,
      timezone: over.timezone ?? null,
    })
    .returning();
  return row;
}

export async function seedConnection(over: {
  memberId: number;
  grantEmail: string;
  grantId?: string;
  provider?: string;
  clientId?: string | null;
  status?: "connected" | "revoked";
  isPrimary?: boolean;
  connectedAt?: Date;
  /** Pass null for a leftover row from the Nylas era — no refresh token, so
   * isConnectionUsable rejects it and the member reads as "needs reconnect".
   * Defaults to present, because that is now the normal case. */
  refreshToken?: string | null;
}) {
  const refreshToken = over.refreshToken === undefined ? "seeded-refresh-token" : over.refreshToken;
  const [row] = await db
    .insert(calendarConnections)
    .values({
      memberId: over.memberId,
      nylasGrantId: over.grantId ?? `grant-${over.grantEmail}`,
      provider: over.provider ?? "google",
      grantEmail: over.grantEmail,
      nylasClientId: over.clientId === undefined ? TEST_CLIENT_ID : over.clientId,
      // Encrypted for real rather than stubbed, so anything that decrypts it
      // exercises the same path production does.
      refreshTokenEncrypted: refreshToken === null ? null : encryptToken(refreshToken),
      connectionStatus: over.status ?? "connected",
      isPrimary: over.isPrimary ?? false,
      ...(over.connectedAt ? { connectedAt: over.connectedAt } : {}),
    })
    .returning();
  return row;
}

export async function seedEvent(over: {
  organizerMemberId: number;
  idempotencyKey: string;
  startsAt: Date;
  durationMinutes?: number;
  title?: string;
  status?: "confirmed" | "cancelled";
  nylasEventId?: string;
  organizerGrantId?: string | null;
  attendees?: { memberId: number; email: string; role?: "guest" | "advisor" }[];
}) {
  const duration = over.durationMinutes ?? 60;
  const [row] = await db
    .insert(events)
    .values({
      title: over.title ?? "test session",
      startsAt: over.startsAt,
      endsAt: new Date(over.startsAt.getTime() + duration * 60_000),
      timezone: "America/Los_Angeles",
      organizerMemberId: over.organizerMemberId,
      nylasEventId: over.nylasEventId ?? `nylas-${over.idempotencyKey}`,
      // Explicit undefined check, not ??: a test passing null is asking for a
      // row that predates the organizer_grant_id column, and ?? would quietly
      // hand it the default instead — making the fallback path untestable.
      organizerGrantId:
        over.organizerGrantId === undefined ? "grant-organizer" : over.organizerGrantId,
      status: over.status ?? "confirmed",
      idempotencyKey: over.idempotencyKey,
    })
    .returning();

  if (over.attendees?.length) {
    await db.insert(eventAttendees).values(
      over.attendees.map((a) => ({
        eventId: row.id,
        memberId: a.memberId,
        attendeeEmail: a.email,
        role: a.role ?? ("guest" as const),
      }))
    );
  }
  return row;
}
