# FounderNexus Scheduler — Technical Specification

**Status:** live in production · **Last updated:** 2026-08-14
**Live:** https://fn-calendar-liard.vercel.app · **Repo:** `foundernexus/fn-calendar` · **Vercel:** FounderNexus team → `fn-calendar`

---

## 0. Access — how to get in

**Sign in: https://fn-calendar-liard.vercel.app/connect**

Same entry point for everyone. Enter your work email, connect Google / Microsoft / iCloud, and you land on
`/me` (member) or `/admin/find-a-time` (admin).

⚠️ **There is no self-signup.** Sending someone this link is not enough — an address that has no `members`
row gets `"No matching member found. Contact an admin to be added."` To add someone today:

1. Add them to `SEED_MEMBERS` in `src/db/seed.ts` and run `npm run db:seed`.
2. If they need admin, also add their address to `ADMIN_EMAILS` in Vercel and redeploy — read §11 first, that
   variable is write-only and overwriting it blind drops existing admins.

Removing this two-step is exactly what §9.1 is about.

You must OAuth with the **same address** you were registered under. The callback verifies the Google/Microsoft
account matches before granting anything, so signing in with a personal account fails even if your work
address is allowlisted.

---

## 1. What this is and why it exists

Booking an expert session between a facilitator and several founders used to mean an email poll: propose times, wait, collect replies, discover a clash, repeat. This tool removes that loop.

Members connect their real calendar once. An admin then picks a session lead and a set of guests, and sees — in one grid — every time slot where **all** of them are genuinely free. Clicking a slot creates the real calendar event and sends real invites immediately.

The core design commitment, which shapes almost every decision below: **we read free/busy only, never event content.** The app cannot see titles, attendees, or descriptions of anyone's existing meetings. This is enforced structurally — there is exactly one Nylas availability call in the codebase and it returns time ranges only.

---

## 2. Stack

| Layer | Choice |
|---|---|
| Framework | Next.js 16.3.0, App Router, Turbopack |
| Runtime | React 19.2.8, TypeScript, Node 24 |
| Database | Neon Postgres via `@neondatabase/serverless` (HTTP driver) |
| ORM | Drizzle 0.45 + drizzle-kit migrations |
| Calendar | Nylas v8 SDK (Google / Microsoft / iCloud behind one hosted auth page) |
| UI | Tailwind v4, Base UI, shadcn-style components, sonner toasts |
| Validation | Zod 4 on every request body |
| Tests | Vitest — 64 tests across 6 files |
| Hosting | Vercel (auto-deploys on push to `main`) |

**Note on the Neon HTTP driver:** it does not support multi-statement transactions. Several routes are written to degrade safely because of this — see `api/me/route.ts:64-68` for the reasoning behind its deliberate upsert-then-delete ordering.

---

## 3. Data model

Five tables. Full definitions in `src/db/schema.ts`; migrations in `drizzle/`.

### `members`
The roster. **There is no self-signup** — a person must already have a row here before they can sign in at all.

| Column | Notes |
|---|---|
| `email` | Unique, always normalised through `normalizeEmail()` before read or write |
| `full_name` | Display name |
| `role` | `member` \| `admin` — **descriptive metadata only, grants nothing.** See §4 |
| `is_facilitator` | Gates who can be picked as "Session lead". A curated subset — connecting a calendar does not make you one |
| `timezone` | **Nullable on purpose.** `NULL` means "has never saved `/me`", which is treated as *unrestricted* rather than *unavailable* |
| `weekly_session_cap` | Default 5. Applies to guests only, never the session lead |

### `calendar_connections`
One row per Nylas grant. A member reconnecting produces additional rows over time; queries resolve to the newest.

| Column | Notes |
|---|---|
| `nylas_grant_id` | Unique. The Nylas handle for the connected account |
| `provider` | Free text, not an enum — stores whatever Nylas reports, so a new provider needs no migration |
| `grant_email` | **The address actually connected**, which may differ from `members.email` |
| `nylas_client_id` | Which Nylas app minted this grant. `NULL` = pre-dates the column, treated as stale |
| `connection_status` | `connected` \| `revoked` |

A connection is only *usable* when `connection_status = 'connected'` **and** `nylas_client_id` matches the currently configured `NYLAS_CLIENT_ID` (`isConnectionUsable`, `queries.ts:125`). Grants do not survive a move between Nylas apps (Sandbox → Production, or an app rotation), so a row can read "connected" and still be dead. The UI surfaces this as a distinct *needs reconnect* state rather than silently failing.

### `member_availability`
A member's own stated weekly windows, set on `/me`. One row per enabled day.

**Absence of a row means that day is off** — there is no separate `enabled` boolean to keep in sync. Times are `"HH:mm"` strings; `day_of_week` is 0=Sunday..6=Saturday throughout the codebase.

### `events`
Sessions booked through the tool.

`idempotency_key` is unique and is the real duplicate-booking guarantee. It hashes the sorted guest IDs + slot start + duration. **The organizer is deliberately excluded from the hash** — the same guests at the same time is a duplicate regardless of who leads it.

### `event_attendees`
Join table, unique on `(event_id, member_id)`.

⚠️ `response_status` exists in the schema but **is never read or written** anywhere in the application. There is no webhook ingest, so RSVPs made in Google/Outlook do not flow back. Treat it as a placeholder.

---

## 4. Authentication and authorisation

This is the most security-sensitive part of the system and the part most likely to be misunderstood. Read this section before touching auth.

### Admin access comes from an env var, not the database

`ADMIN_EMAILS` is a comma-separated allowlist in Vercel's environment config. `isAdminEmail()` (`src/lib/auth/admin.ts:15`) splits it, normalises each entry, and checks membership.

**`members.role` does not grant admin access.** It is descriptive only — `schema.ts:29` says so explicitly. Someone can be `role = 'admin'` in the database and have no admin access whatsoever, and vice versa. This trips people up constantly.

### Typing an email proves nothing

Every login — member or admin, first or thousandth — goes through a full Nylas OAuth round trip. `POST /api/connect/start` decides only *which state-token tag* to use (`redirectTo: "admin"` or nothing) and **grants nothing by itself**.

The admin session is minted in exactly one place: `/api/nylas/callback`, and only after confirming both that

1. the Google/Microsoft account actually signed into matches the member's registered email exactly, and
2. the address is *still* on the live allowlist (in case it was removed during the 10-minute OAuth window).

On mismatch it bails out **before touching `calendar_connections`** — so an attacker who starts the flow for someone else's `memberId` but authenticates as themselves cannot overwrite that person's real connection.

### Sessions

Two HMAC-SHA256 signed cookies, both keyed on `SESSION_SECRET`, both carrying a `purpose` tag so a token minted for one use can never be replayed as another:

| Cookie | TTL | Meaning |
|---|---|---|
| `fn_admin_session` | 8 hours | Short — shared-context login |
| `fn_member_session` | 90 days | Long — a member logs in once by connecting a calendar |

`SESSION_SECRET` is the one env var with an enforced minimum (32 chars, `env.ts:25`) — a weak value here means forgeable admin sessions.

### Two-layer route protection

`src/proxy.ts` matches `/admin/*`, `/api/admin/*`, `/me/*`, `/api/me/*` and re-checks the **live** allowlist on every request, so removing someone from `ADMIN_EMAILS` takes effect on their next request rather than when their cookie expires.

Every admin page and route additionally calls `requireAdminSession()` itself, per Next.js's own guidance not to rely on middleware alone — a matcher edit or a moved route would otherwise silently remove protection.

---

## 5. User workflows

### 5.1 Member — connecting a calendar

```
/connect  →  enter email  →  POST /api/connect/start
                                     │
                    ┌────────────────┴────────────────┐
              not in members                    found in members
                    │                                 │
     "No matching member found.            Nylas hosted auth (Google /
      Contact an admin to be added."        Microsoft / iCloud picker)
                                                      │
                                        /api/nylas/callback
                                                      │
                                   upsert calendar_connections
                                    + mint member session cookie
                                                      │
                                        redirect → /me
```

On `/me` a member sets their timezone, their weekly availability windows (one time range per enabled day), and their weekly session cap. They can also disconnect or reconnect.

⚠️ **Disconnect is a local flag only.** `POST /api/me/disconnect` marks rows `revoked`; it does **not** call Nylas to revoke the real OAuth grant. The grant stays live on Nylas's side.

### 5.2 Admin — booking a session

```
/connect (same entry point, admin email)  →  OAuth  →  /admin/find-a-time
                                                              │
              pick session lead (facilitators only) + guests + date range
                    + duration (30/45/60) + working hours + timezone
                                                              │
                                            POST /api/admin/availability
                                                              │
                                                   availability grid
                                                              │
                                        click a slot → create-event dialog
                                          (title, description, meeting URL)
                                                              │
                                              POST /api/admin/events
                                                              │
                              real Nylas event + real invites sent immediately
```

There is **no dry-run mode.** Clicking confirm sends real calendar invites to real people.

---

## 6. The availability algorithm

`POST /api/admin/availability` applies four independent layers. Understanding that these are *separate* explains most "why is this slot missing?" questions.

**Layer 1 — real calendar free/busy (Nylas).**
A single collective-availability call where every participant must be free. Constrained by the admin's date range, working hours, duration, and optional weekend exclusion. Interval is 30 minutes (`AVAILABILITY_INTERVAL_MINUTES`), and `roundTo` must match it exactly or returned slots land between grid rows and silently fail to render.

Participants are deduped by `grant_email`, **not** member ID — two members could share one connected account.

**Layer 2 — each member's own stated windows.**
Nylas has no idea someone set "Mondays 2–5pm only" on `/me`. Every selected member — lead *and* guests — must independently clear their own window, evaluated **in their own timezone**, because "2pm" means 2pm where they are, not where the admin searched.

**Layer 3 — weekly session cap (guests only).**
Each guest's already-confirmed sessions are bucketed into weeks in their own timezone (weeks start Sunday) and compared against `weekly_session_cap`. Never applied to the session lead — running several sessions a week is a facilitator's job, and capping them would block their normal workload.

The DB fetch uses a **±7 day buffer** around the search range: a slot near either edge belongs to a week extending up to 6 days beyond it, and a narrower buffer silently undercounts.

**Layer 4 — sessions already booked through this tool.**
Surfaced as distinct "already booked" cells so an admin sees *why* a slot is unavailable instead of an unexplained gap.

### Response fields worth knowing

| Field | Meaning |
|---|---|
| `notConnectedNames` | Selected people with no usable connection. Does **not** block the search |
| `checkedCount` / `totalSelected` | Counted in *people*, deliberately not calendars |
| `filteredByPreferences` | `true` when Nylas found real overlap but every slot was removed by a stated `/me` window — lets the UI avoid falsely claiming "no overlapping free time" |

---

## 7. Booking and idempotency

`POST /api/admin/events`:

1. Drops the lead from the guest list if present, so the hash, Nylas participants, and `event_attendees` all agree.
2. Computes the idempotency key and fast-path checks for an existing row (an optimisation, *not* the guarantee).
3. Re-verifies the lead is connected and is a facilitator — the UI filters client-side, which is not a guarantee.
4. **Re-checks every guest's weekly cap**, because the grid may be stale or another admin may have booked concurrently.
5. Creates the Nylas event on the **lead's grant** with `notifyParticipants: true`.
6. Inserts `events`, then `event_attendees`.

Invitees are addressed by `grant_email` where available, falling back to `members.email`. This matters: availability was checked against the connected calendar, so inviting a different address would invite a calendar nobody verified as free.

### Known failure modes (accepted for V1, all logged)

- **Lost idempotency race.** Two concurrent requests both pass the pre-check; the unique constraint stops the second insert, but its Nylas event was already created and is now orphaned — a real calendar event no DB row references.
- **`event_attendees` insert fails after `events` succeeded.** Invites are already out. Returns success rather than implying nothing happened.
- Every path after the Nylas call reports honestly that invites may already have been sent.

**Limit:** 49 guests + 1 lead = Nylas's 50-participant cap.

---

## 8. Can we sync several calendars per person?

**Not today — on two separate axes. Both are fixable.**

### Axis 1: one connected *account* per member

`getLatestConnections()` (`queries.ts:150`) runs `SELECT DISTINCT ON (member_id) … ORDER BY member_id, connected_at DESC`. A member may accumulate many `calendar_connections` rows, but **only the most recent is ever used.** Connecting a second account silently supersedes the first.

### Axis 2: only the *primary* calendar within that account

`src/lib/nylas.ts:81` pins every participant to `calendarIds: ["primary"]`. A secondary calendar in the same Google account — a separate "Coaching" or "Personal" calendar — is invisible to the availability check. Busy time there will **not** block a booking.

### What each fix requires

| Goal | Work |
|---|---|
| **Multiple calendars in one account** (most people's actual need) | Fetch the grant's calendar list via Nylas, let the member tick which to include on `/me`, persist the selection, pass those IDs instead of `["primary"]`. No schema change to `calendar_connections`. Small-to-medium. |
| **Multiple accounts per member** (work + personal Google) | Drop the `DISTINCT ON` collapse, allow N active grants per member, and pass every grant email as a participant. Touches `getLatestConnections`, `getActiveConnections`, `getMemberConnectionState`, and every connection-state UI. Medium — the "one connection" assumption is load-bearing across the codebase. |

**Recommendation:** ship the first. It covers the common case (people who keep several calendars inside one work account) at a fraction of the cost, and is additive rather than a refactor.

---

## 9. Integrating into FounderNexus

Two placements are planned. Both are straightforward *product* changes; the real work in both cases is **identity**.

### 9.1 "Connect your calendar" in the Founder profile

Today `/connect` asks for an email and requires a pre-existing `members` row. Inside FounderNexus the founder is already authenticated, so asking them to retype their address is redundant and the "Contact an admin to be added" dead-end is unacceptable.

**Required changes:**

1. **Signed handoff instead of email entry.** FounderNexus mints a short-TTL HMAC token carrying the founder's identity and redirects to `/connect?token=…`. Reuse the existing `signValue`/`verifyValue` helpers in `src/lib/auth/session.ts` with a new `TOKEN_PURPOSE` tag — the primitive is already there and already purpose-tagged.
2. **Auto-provision the member row.** On a valid handoff, upsert into `members` rather than rejecting. This replaces `db:seed` as the way people enter the system.
3. **Decide redirect vs embed.** A full-page redirect is simplest and avoids third-party-cookie problems in an iframe. Nylas hosted auth cannot be iframed anyway, so a redirect is needed for at least part of the flow regardless.
4. **Post-connect return URL.** The callback currently hardcodes `/me`. It should return the founder to their FounderNexus profile. Make the destination part of the signed state.

### 9.2 Admin view in the Create Session dashboard

`/admin/find-a-time` is the whole scheduling UI and can move largely as-is.

**Required changes:**

1. **Replace `ADMIN_EMAILS` with a FounderNexus role claim.** An env var allowlist does not scale past a handful of people and requires a redeploy for every change. The check is centralised in one function (`isAdminEmail`) plus `proxy.ts`, so the blast radius is small.
2. **Expand the timezone list.** `TIMEZONES` in `src/lib/time.ts` offers only four US zones for admin search. Members can already set any IANA zone on `/me`. If founders are international this must grow.
3. **Facilitator management UI.** `is_facilitator` currently has no admin interface — it is set by seed script or direct SQL.
4. **Keep the two-layer auth pattern.** Whatever replaces the allowlist should still be checked both in middleware and inside each route.

### 9.3 Sequencing suggestion

Identity handoff first (§9.1 items 1–2), because it unblocks real founders self-serving. The admin dashboard move can follow independently — it has no dependency on the founder-side work.

---

## 10. Known limitations

- **No cancellation or rescheduling.** `events.status` has a `cancelled` value but no route ever sets it.
- **No webhook sync.** RSVPs, edits, and deletions made directly in Google/Outlook never flow back. `response_status` is inert.
- **Disconnect does not revoke the Nylas grant** (§5.1).
- **Slots spanning local midnight are dropped** for members far from the search timezone. `/me` windows cannot cross midnight, so this is mathematically correct but can exclude hours a member would accept. No way to express an overnight window.
- **Members who never saved `/me` are unrestricted**, not blocked — deliberate, so existing members were not locked out when the feature shipped.
- **Admin search is limited to four US timezones.**
- **A stale comment** in `src/app/api/me/disconnect/route.ts:7` references an open `/api/connect/disconnect` route that no longer exists. Harmless, worth deleting.

---

## 11. Operations

### Environment variables

`DATABASE_URL`, `NYLAS_API_KEY`, `NYLAS_CLIENT_ID`, `NYLAS_API_URI`, `NYLAS_CALLBACK_URI`, `ADMIN_EMAILS`, `APP_URL`, `SESSION_SECRET`.

Set in Vercel under FounderNexus → `fn-calendar` → Settings → Environment Variables, for Production and Preview.

⚠️ **`ADMIN_EMAILS` is marked Sensitive, which makes it write-only** — the dashboard shows an empty field and copy-to-clipboard is disabled. Overwriting it therefore destroys the previous value with no way to read it back first. On 2026-08-14 this caused an admin to be silently dropped.

**Always reconstruct the current value before editing.** Method: `POST {"email":"…"}` to `/api/connect/start`, take the `state` param from the returned URL, base64url-decode its first segment, and check for `redirectTo: "admin"`. Previous deployments retain the env vars they were built with, so an already-overwritten value can be recovered by probing the old deployment URL — though those sit behind Vercel deployment protection and must be called from an authenticated browser session.

**Env changes require a redeploy** to take effect.

### Deploys

Push to `main` → Vercel auto-deploys. Confirmed working.

### Adding people

Currently `src/db/seed.ts` + `npm run db:seed`. Uses `onConflictDoNothing` on email, so re-running is safe for existing rows.

⚠️ **`.env.local`'s `DATABASE_URL` is the production database.** There is no separate dev copy. Local `db:seed` and any local script using that connection string write to live production data.

### Commands

```bash
npm run dev          # local dev server
npm run build        # production build
npm test             # vitest, 64 tests
npm run lint
npm run db:generate  # generate a migration from schema changes
npm run db:migrate   # apply migrations
npm run db:seed      # upsert the seed member list
```

---

## 12. Test coverage

64 tests across 6 files, concentrated on the logic most prone to silent regression:

| File | Covers |
|---|---|
| `lib/time.test.ts` | Timezone conversion, availability-window matching, weekly-cap bucketing, date arithmetic |
| `lib/auth/session.test.ts` | Sign/verify, purpose-tag mismatch, expiry, malformed input |
| `lib/auth/admin.test.ts` | Allowlist parsing and normalisation |
| `lib/idempotency.test.ts` | Key stability and ordering independence |
| `lib/email.test.ts` | Normalisation |
| `lib/timezones.test.ts` | Supported-zone validation |

The deliberate gap is anything requiring a live Nylas call. Route handlers are covered indirectly through their pure helpers.
