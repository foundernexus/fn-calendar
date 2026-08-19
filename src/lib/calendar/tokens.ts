import { eq } from "drizzle-orm";
import { db } from "@/db";
import { calendarConnections } from "@/db/schema";
import { encryptToken, decryptToken } from "@/lib/calendar/crypto";
import { refreshGoogleToken } from "@/lib/calendar/google";
import { refreshMicrosoftToken } from "@/lib/calendar/microsoft";

/** Access tokens live about an hour. Refreshing one costs a round trip, so the
 * current one is cached on the row and only replaced when it's close to
 * expiring.
 *
 * The 2-minute margin exists because a token that is valid when we check and
 * expired by the time the provider sees it produces a 401 in the middle of a
 * booking — the worst possible moment. Better to refresh slightly early. */
const EXPIRY_MARGIN_MS = 2 * 60 * 1000;

export class ConnectionUnusableError extends Error {
  constructor(readonly connectionId: number, message: string) {
    super(message);
    this.name = "ConnectionUnusableError";
  }
}

type TokenRow = {
  id: number;
  provider: string;
  refreshTokenEncrypted: string | null;
  accessTokenEncrypted: string | null;
  accessTokenExpiresAt: Date | null;
};

/** A usable access token for this connection, refreshing if necessary.
 *
 * Throws ConnectionUnusableError rather than returning null, because every
 * caller would otherwise have to remember to check — and forgetting means
 * sending `undefined` as a bearer token and reading the provider's confusing
 * 401 instead of our own clear message.
 *
 * A connection with no refresh token is one of the pre-switch Nylas rows. It
 * cannot be used here and never will be; the member has to reconnect. */
export async function getAccessToken(row: TokenRow): Promise<string> {
  if (!row.refreshTokenEncrypted) {
    throw new ConnectionUnusableError(
      row.id,
      "This calendar was connected through the old system and has to be reconnected."
    );
  }

  const cached = usableCachedToken(row);
  if (cached) return cached;

  const refreshToken = decryptToken(row.refreshTokenEncrypted);
  // Typed as the union of both providers' shapes so the rotated-token case is
  // handled uniformly — Google simply never populates it.
  const refreshed: { accessToken: string; expiresAt: Date; refreshToken?: string } =
    row.provider === "microsoft"
      ? await refreshMicrosoftToken(refreshToken)
      : await refreshGoogleToken(refreshToken);

  // Microsoft rotates refresh tokens: the response often carries a NEW one and
  // retires the old. Persisting it is not optional — miss it once and the
  // connection works until the next rotation, then dies permanently with no
  // obvious cause. Google returns none here and keeps the original valid.
  const rotated = refreshed.refreshToken;

  await db
    .update(calendarConnections)
    .set({
      accessTokenEncrypted: encryptToken(refreshed.accessToken),
      accessTokenExpiresAt: refreshed.expiresAt,
      ...(rotated ? { refreshTokenEncrypted: encryptToken(rotated) } : {}),
    })
    .where(eq(calendarConnections.id, row.id));

  return refreshed.accessToken;
}

/** The cached token, if it exists and has comfortably longer than the margin
 * left. Returns undefined rather than throwing on a decryption failure: a
 * corrupted CACHE is recoverable by refreshing, unlike a corrupted refresh
 * token, so it should cost a round trip and not an outage. */
function usableCachedToken(row: TokenRow): string | undefined {
  if (!row.accessTokenEncrypted || !row.accessTokenExpiresAt) return undefined;
  if (row.accessTokenExpiresAt.getTime() - Date.now() <= EXPIRY_MARGIN_MS) return undefined;
  try {
    return decryptToken(row.accessTokenEncrypted);
  } catch {
    return undefined;
  }
}

/** Stores a freshly-authorised connection's tokens.
 *
 * Refuses without a refresh token. Google only issues one on a first
 * authorisation — which is why buildGoogleAuthUrl always sends
 * prompt=consent — and a row saved without one looks connected, works for an
 * hour, and then goes quiet with nothing on screen to explain it. Failing here
 * turns that into an honest error at connect time. */
export function encryptedTokenFields(tokens: {
  accessToken: string;
  refreshToken?: string;
  expiresAt: Date;
}) {
  if (!tokens.refreshToken) {
    throw new Error(
      "The provider returned no refresh token, so this calendar could not be connected permanently."
    );
  }
  return {
    refreshTokenEncrypted: encryptToken(tokens.refreshToken),
    accessTokenEncrypted: encryptToken(tokens.accessToken),
    accessTokenExpiresAt: tokens.expiresAt,
  };
}
