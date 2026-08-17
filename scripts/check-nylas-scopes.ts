/**
 * Asserts that the live Nylas connectors request calendar access and nothing
 * else. Run it after any change in the Nylas dashboard: `npm run check:scopes`.
 *
 * Why this exists: the OAuth scopes a member is asked to approve are NOT set in
 * this codebase. `buildHostedAuthUrl` deliberately passes no `scope` (see
 * src/lib/nylas.ts), because scope strings are provider-specific and we let
 * Nylas's hosted page pick the provider. That means the connector's default
 * scope array — editable in the dashboard by anyone with access, and shipped by
 * Nylas with mail + contacts turned ON — is the only thing standing between a
 * member and handing us their whole inbox.
 *
 * Nylas's stock Google connector defaults to gmail.modify + contacts +
 * calendar, and the stock Microsoft one to Mail.ReadWrite + Mail.Send +
 * Contacts.ReadWrite + People.Read. Both were live in production until
 * 2026-08-17. This app only ever calls two Nylas endpoints — free/busy
 * availability and event creation — so neither mail nor contacts is ever used.
 */
import { config } from "dotenv";

config({ path: ".env.local" });

/** The full set each provider may request. Anything beyond this is a finding.
 * openid/email/profile stay: Nylas needs them to resolve the grant's email
 * address, which /api/nylas/callback compares against the member's registered
 * address to decide whether to mint an admin session. Drop them and admin
 * verification silently loses the value it checks. */
const ALLOWED: Record<string, string[]> = {
  google: [
    "openid",
    "https://www.googleapis.com/auth/userinfo.email",
    "https://www.googleapis.com/auth/userinfo.profile",
    // Calendar list + free/busy, for getCollectiveAvailability.
    "https://www.googleapis.com/auth/calendar.readonly",
    // Create/update events, for createNylasEvent. Deliberately NOT the broad
    // .../auth/calendar, which also grants deleting calendars and editing
    // sharing rules — neither of which this app does.
    "https://www.googleapis.com/auth/calendar.events",
  ],
  microsoft: [
    "openid",
    "email",
    "profile",
    "offline_access",
    "User.Read",
    "Calendars.ReadWrite",
  ],
};

type Connector = { provider: string; scope?: string[] };

async function main() {
  const res = await fetch(`${process.env.NYLAS_API_URI}/v3/connectors`, {
    headers: { Authorization: `Bearer ${process.env.NYLAS_API_KEY}` },
  });
  if (!res.ok) {
    throw new Error(`Nylas returned ${res.status} listing connectors`);
  }
  const { data } = (await res.json()) as { data: Connector[] };

  let failed = false;
  for (const connector of data) {
    const allowed = ALLOWED[connector.provider];
    if (!allowed) {
      // imap has no scope array at all — it takes raw mailbox credentials and
      // grants full mail access with no calendar capability whatsoever. It is
      // pure attack surface for a calendar-only tool and should be deleted
      // from the Nylas app rather than allowlisted here.
      console.error(`FAIL ${connector.provider}: connector is not calendar-capable, remove it`);
      failed = true;
      continue;
    }
    const extra = (connector.scope ?? []).filter((s) => !allowed.includes(s));
    if (extra.length) {
      console.error(`FAIL ${connector.provider}: unexpected scopes ${extra.join(", ")}`);
      failed = true;
    } else {
      console.log(`ok   ${connector.provider}: ${(connector.scope ?? []).length} scopes, all allowed`);
    }
  }

  // process.exitCode rather than process.exit() — the latter tears down libuv
  // mid-fetch on Windows and prints a spurious native assertion after the
  // real output, which reads like the script itself crashed.
  if (failed) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
