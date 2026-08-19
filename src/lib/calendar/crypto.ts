import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { env } from "@/lib/env";

/** Encryption for the OAuth refresh tokens we now hold ourselves.
 *
 * This is the one genuinely new responsibility taken on by dropping Nylas.
 * Previously the tokens lived on their servers and we stored an opaque grant
 * id; now a row in `calendar_connections` is a live, long-lived credential to
 * somebody's calendar. A database dump must not be a set of working keys to
 * every founder's diary.
 *
 * AES-256-GCM, so tampering is detected rather than silently decrypting to
 * rubbish — a truncated or edited ciphertext throws instead of producing a
 * token-shaped string that then fails confusingly against the provider.
 *
 * The key is derived from SESSION_SECRET rather than living in its own
 * variable. One fewer secret to set, rotate and lose — but the consequence is
 * real and worth stating plainly: ROTATING SESSION_SECRET MAKES EVERY STORED
 * TOKEN UNDECRYPTABLE. Nothing is corrupted and nothing leaks; every member
 * simply has to reconnect. Rotate it deliberately, not casually.
 *
 * The HKDF `info` string keeps this key distinct from the one signing session
 * cookies, so the same secret never does two jobs with the same bytes. */
const KEY_INFO = "fn-calendar/token-encryption/v1";
const VERSION = "v1";

function key() {
  if (env.SESSION_SECRET.length < 32) {
    // The env schema already enforces this; belt and braces, because a short
    // key here would silently weaken every stored token.
    throw new Error("SESSION_SECRET is too short to derive a token encryption key");
  }
  return Buffer.from(hkdfSync("sha256", Buffer.from(env.SESSION_SECRET), Buffer.alloc(0), KEY_INFO, 32));
}

/** Returns "v1.<iv>.<tag>.<ciphertext>", each part base64url.
 *
 * Versioned so a future key rotation or algorithm change can recognise old
 * rows and migrate them rather than failing on every one at once. */
export function encryptToken(plaintext: string): string {
  if (!plaintext) throw new Error("Refusing to encrypt an empty token");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, b64(iv), b64(tag), b64(ciphertext)].join(".");
}

export function decryptToken(payload: string): string {
  const parts = payload.split(".");
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new Error("Stored token is not in the expected encrypted format");
  }
  const [, ivPart, tagPart, ctPart] = parts;
  const decipher = createDecipheriv("aes-256-gcm", key(), unb64(ivPart));
  decipher.setAuthTag(unb64(tagPart));
  // Throws on a bad tag — which is the point. A tampered or truncated value
  // must not decrypt to something that merely looks wrong later.
  return Buffer.concat([decipher.update(unb64(ctPart)), decipher.final()]).toString("utf8");
}

function b64(buf: Buffer) {
  return buf.toString("base64url");
}
function unb64(str: string) {
  return Buffer.from(str, "base64url");
}
