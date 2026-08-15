# Stack & Workflow Playbook

How the FounderNexus Scheduler was actually built — every service, how they connect, what each costs, and
the working method. Written to be lifted wholesale into the next project.

**Last updated:** 2026-08-14

---

## 1. The infrastructure, end to end

```
        ┌──────────────┐
        │   GitHub     │  source of truth
        │ foundernexus │  push to main ──┐
        │ /fn-calendar │                 │
        └──────────────┘                 │ webhook, auto-deploy
                                         ▼
   ┌─────────────┐              ┌──────────────────┐
   │    Neon     │◀── SQL ──────│      Vercel      │  build + host + env vars
   │  Postgres   │   (HTTP)     │   fn-calendar    │  preview URL per branch
   └─────────────┘              └──────────────────┘
                                    │          ▲
                          OAuth +   │          │  free/busy, event create
                        free/busy   ▼          │
                                ┌──────────────────┐
                                │      Nylas       │  one API for Google /
                                │   (calendar)     │  Microsoft / iCloud
                                └──────────────────┘
                                    │          ▲
                                    ▼          │
                            member's real calendar
```

Four external services. That is the entire operational footprint.

### What each one is for, and why it was the right pick

| Service | Job | Why this one |
|---|---|---|
| **Neon** | Postgres database | Serverless Postgres over HTTP — no connection pooling headaches on a serverless host. Generous free tier. **Database branching** means you can fork the whole DB for a dev environment in seconds |
| **Nylas** | Calendar integration | The reason this project was feasible at all. One integration covers Google, Microsoft **and** iCloud, including a hosted OAuth screen. Doing this directly means a Google Cloud OAuth app, an Azure app registration, Apple app-specific passwords, and three different free/busy APIs |
| **Vercel** | Build, host, env vars, CI/CD | Push to `main` → live in ~25 seconds. Zero pipeline config. Preview deployment per branch. Env var management with Production/Preview separation |
| **GitHub** | Source control, deploy trigger | Vercel watches it. Nothing else needed — no separate CI |

### Costs, as observed

- **Neon** — free tier is enough for this workload.
- **Nylas** — **sandbox tier is free** and comes with Google and Microsoft connectors pre-configured, so there is no Google Cloud or Azure setup at all for a prototype. ⚠️ Grants do not transfer between sandbox and production apps — see the reconnect trap in §5.
- **Vercel** — this team is on **Pro**. Usage observed mid-cycle: $5.58 of $20 included credit, mostly build minutes.
- **GitHub** — free.

A prototype of this shape costs roughly the Vercel subscription and nothing else.

### The in-app stack

| Layer | Choice | Note |
|---|---|---|
| Framework | Next.js 16 App Router | Server Components mean data fetching without a separate API layer for pages |
| ORM | Drizzle + drizzle-kit | Schema in TypeScript, migrations generated from it. Read the generated SQL before applying |
| Validation | Zod 4 | On **every** request body, no exceptions |
| UI | Tailwind v4 + shadcn/Base UI | `npx shadcn@latest add <component>` as needed |
| Tests | Vitest | 64 tests, all on pure logic |
| Auth | Hand-rolled HMAC cookies | ~130 lines, no dependency. See §4 |

---

## 2. Setting up the same stack from scratch

Ordered so nothing blocks on anything later.

1. **`npx create-next-app@latest`** — TypeScript, Tailwind, App Router, `src/` dir, `@/*` alias, ESLint.
2. **Neon project** — pick a region near your users, copy the **pooled** connection string.
3. **Nylas sandbox app** — same region, sandbox tier. Copy API key + Client ID. Register your callback URL:
   `http://localhost:3000/api/nylas/callback`. **Add the production callback after the first deploy** — forgetting
   this is the single most common way the OAuth flow breaks in production while working locally.
4. **`.env.example` committed, `.env.local` git-ignored.** Do this before writing any code that reads env.
5. **Drizzle schema + first migration** — `db:generate`, read the SQL, `db:migrate`.
6. **Push to GitHub, import to Vercel**, set the same env vars there for Production and Preview.
7. **Deploy, then go back to Nylas** and register the production callback URL.

Steps 3 and 7 are the same task split in two. That split is deliberate — you cannot know your production URL
until after the first deploy.

---

## 3. The working method

There were no custom slash-commands or skills. Everything below is built-in.

### Plan mode is where the value is

The surviving plan file from the V2 build (`~/.claude/plans/`) shows the pattern that worked, and it is worth
copying deliberately. Its structure:

1. **Context** — what already exists, and what problem this specifically solves.
2. **Confirmed product decisions** — an explicit list, each with its reasoning. "Login = successful calendar
   connection. No member-facing password."
3. **Explicitly out of scope** — a named list of things *not* to build. This section prevents more waste than
   any other.
4. **Data flow, end to end** — numbered, from user action to database write.
5. **Implementation** — numbered steps, each naming the files it touches.
6. **Verification** — how you will know it worked.

The out-of-scope list is the part most people skip and the part that pays most. In that plan it read: no member
dashboard, no viewing scheduled sessions, no minimum-notice setting, no multiple time blocks per day.

**Prompt shape that produces this:** describe the problem and the constraint, ask for a plan, then answer the
clarifying questions properly rather than saying "you decide". The interview is where the quality comes from.

### Built-in commands worth knowing

| Command | Use it for |
|---|---|
| `/code-review` | Review of your working diff before committing |
| `/security-review` | Security pass on pending changes — worth running on anything touching auth |
| `/simplify` | Reuse, dead code, over-abstraction. Quality only, not bug-hunting |
| `/init` | Generate the initial `CLAUDE.md` for a new repo |
| `/run` | Launch the app and confirm a change actually works |

### Repo files that steer the agent

- **`AGENTS.md` / `CLAUDE.md`** — project instructions loaded every session. This repo's says to read the local
  Next.js docs before writing code, because the installed version differs from training data. That one
  instruction prevents a recurring class of wrong answers.
- **`.claude/settings.local.json`** — an accumulated allow-list of commands that no longer prompt. It grows
  naturally; there is no need to design it up front.

---

## 4. Decisions in this codebase worth copying

- **Hand-rolled HMAC session cookies.** ~130 lines in `src/lib/auth/session.ts`, no auth dependency, no vendor.
  Every token carries a `purpose` tag so one minted for OAuth state cannot be replayed as an admin session.
- **The identity check that matters is OAuth, not the typed email.** Typing an address proves nothing; the
  provider-verified email from the OAuth round trip is the real signal.
- **Idempotency keys on anything that costs money or sends email.** A unique DB constraint is the guarantee;
  the pre-flight check is only an optimisation.
- **Test the pure logic, skip the integration.** All 64 tests target timezone math, availability matching,
  token sign/verify, and key stability — the things that break silently. Nothing mocks Nylas.
- **Comment the *why*, not the *what*.** This codebase explains why the organizer is excluded from the
  idempotency hash and why the buffer is ±7 days. That is why a spec could be written from the code months later.

---

## 5. Traps to avoid next time

Each of these cost real time on this project.

**Nylas grants are bound to one Nylas app.** Move from sandbox to production and every existing connection dies
while still reading "connected" in your database. Store the `client_id` alongside the grant from day one and
surface a distinct "needs reconnect" state. Retrofitting this is worse.

**Register the production OAuth callback URL.** Deploy, then immediately add the production callback in the
Nylas dashboard. Otherwise login works locally and fails in production, with a confusing error.

**A "Sensitive" env var on Vercel is write-only.** The dashboard shows an empty field and disables copy. Editing
one therefore destroys the old value with no way to read it first — this silently dropped an admin from the
allowlist. Either keep such values non-sensitive, or keep an authoritative copy elsewhere.

**Point local development at a separate database.** `.env.local` here points at production, so `npm run db:seed`
writes live data. Neon's branching makes a real dev database nearly free — use it from the start.

**Vercel blocks deployments from unlinked commit authors.** If a teammate's GitHub account is not linked to a
Vercel account on the team, their commits produce `Blocked` deployments and a stream of failure emails. Link
everyone's account when they join.

**Watch which account and scope you are operating in.** Vercel CLI and dashboards silently default to whichever
team was last used. Confirm the scope before any write.

---

## 6. Verification techniques worth reusing

Concrete methods from this project that generalise:

- **Verify against production, not against your assumption.** After changing the admin allowlist, the check was
  a real POST to the live API, decoding the returned signed token to confirm the routing changed — not "the
  dashboard says saved".
- **Previous deployments retain their env vars.** An overwritten value can be recovered by probing the old
  deployment URL. Those sit behind deployment protection, so call them from a browser session already
  authenticated to Vercel.
- **Check the relationship between branches before pushing to a new remote.** `git rev-list --count A..B` in both
  directions tells you whether a push is a fast-forward or will clobber.
- **Reproduce a reported failure locally before believing a cause.** A failing deploy was blamed on recent
  commits; `npm run build` passing locally, plus every deployment showing `Ready`, located the real cause in a
  different project entirely.

---

## 7. Starting the next project — the short version

1. `create-next-app`, then `/init` to generate `CLAUDE.md`.
2. Provision Neon and whatever the domain-specific API is. Get credentials into `.env.local` and
   `.env.example` before writing code.
3. Design the schema first. Migrations from day one, never manual SQL.
4. Plan mode for each feature. Insist on the out-of-scope list.
5. Build, then `/security-review` anything touching auth or money.
6. Tests on pure logic only.
7. Push to GitHub, import to Vercel, set env vars, deploy.
8. Circle back and register production callback URLs with every OAuth provider.
9. Write the spec while the reasoning is fresh — `docs/SPEC.md` here is the template.
