/**
 * Generic HMAC-SHA256 sign/verify for short-lived, tamper-proof payloads
 * (the admin session cookie in Step 4, and the OAuth `state` param carrying a
 * member ID through the Nylas hosted-auth round trip in Step 3). Uses Web
 * Crypto (`crypto.subtle`) rather than Node's `crypto` module so the exact
 * same code runs unmodified in both Edge middleware and Node route handlers.
 *
 * Every token embeds a `purpose` string alongside its payload so a token
 * minted for one use (e.g. the OAuth `state` param) can't be replayed
 * somewhere expecting a different shape (e.g. the admin session cookie) even
 * though both are signed with the same SESSION_SECRET.
 */

/** Token purpose tags — keep every signValue/verifyValue call site importing
 * from here so a typo can't silently create two purposes that never match. */
export const TOKEN_PURPOSE = {
  connectState: "connect-state",
  adminSession: "admin-session",
} as const;

function base64url(bytes: ArrayBuffer | Uint8Array) {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let str = "";
  for (const b of arr) str += String.fromCharCode(b);
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Returns `null` (rather than throwing) on malformed input — callers see
 * untrusted values from cookies/query params and must never crash on them. */
function base64urlDecode(value: string): Uint8Array<ArrayBuffer> | null {
  try {
    const padded = value
      .replace(/-/g, "+")
      .replace(/_/g, "/")
      .padEnd(value.length + ((4 - (value.length % 4)) % 4), "=");
    const str = atob(padded);
    const bytes = new Uint8Array(str.length);
    for (let i = 0; i < str.length; i++) bytes[i] = str.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

async function hmacKey(secret: string) {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}

/** Signs `payload` plus a `purpose` tag and expiry, returns `payloadB64.sigB64`. */
export async function signValue<T extends object>(
  purpose: string,
  payload: T,
  secret: string,
  ttlSeconds: number
) {
  const withMeta = {
    ...payload,
    purpose,
    exp: Math.floor(Date.now() / 1000) + ttlSeconds,
  };
  const payloadB64 = base64url(new TextEncoder().encode(JSON.stringify(withMeta)));
  const sig = await crypto.subtle.sign(
    "HMAC",
    await hmacKey(secret),
    new TextEncoder().encode(payloadB64)
  );
  return `${payloadB64}.${base64url(sig)}`;
}

/** Verifies a `signValue` output for the given `purpose`. Returns the payload
 * (with `exp`/`purpose`) if the signature is valid, not expired, and tagged
 * with a matching `purpose` — otherwise `null`. Never throws, even on
 * garbage input. */
export async function verifyValue<T extends object>(
  purpose: string,
  value: string,
  secret: string
): Promise<(T & { exp: number; purpose: string }) | null> {
  const parts = value.split(".");
  if (parts.length !== 2) return null;
  const [payloadB64, sigB64] = parts;
  if (!payloadB64 || !sigB64) return null;

  const sigBytes = base64urlDecode(sigB64);
  if (!sigBytes) return null;

  const valid = await crypto.subtle.verify(
    "HMAC",
    await hmacKey(secret),
    sigBytes,
    new TextEncoder().encode(payloadB64)
  );
  if (!valid) return null;

  const payloadBytes = base64urlDecode(payloadB64);
  if (!payloadBytes) return null;

  let payload: T & { exp: number; purpose: string };
  try {
    payload = JSON.parse(new TextDecoder().decode(payloadBytes));
  } catch {
    return null;
  }

  if (typeof payload.exp !== "number" || payload.exp < Math.floor(Date.now() / 1000)) {
    return null;
  }
  if (payload.purpose !== purpose) return null;

  return payload;
}
