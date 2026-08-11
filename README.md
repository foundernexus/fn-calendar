# fn-calendar

Internal scheduling tool for FounderNexus expert sessions. Members connect their calendar once (Google, Microsoft/Outlook, or iCloud); an admin picks a group, sees when everyone's free, and clicks a slot to send real calendar invites. Replaces the old Mailchimp poll-based scheduling.

This is a **lean V1 / internal prototype** — see the plan doc for full scope and what's deferred.

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Create a Neon Postgres database

1. Go to [neon.tech](https://neon.tech) and create a new project.
2. Region: **US West**.
3. Copy the **pooled** connection string (not the direct one) from the project dashboard.
4. Paste it into `.env.local` as `DATABASE_URL`.

### 3. Create a Nylas sandbox app

1. Go to [dashboard.nylas.com](https://dashboard.nylas.com) and sign up.
2. Create a new application in the **US region**, **sandbox** tier.
3. Sandbox apps come with **Google and Microsoft connectors pre-configured** — no separate Google Cloud or Azure OAuth app needed for this POC. iCloud needs no connector setup either; each person connecting an iCloud calendar just needs their own Apple app-specific password, which Nylas's hosted login screen prompts for directly.
4. Copy the **API key** and **Client ID** into `.env.local` as `NYLAS_API_KEY` and `NYLAS_CLIENT_ID`.
5. Register `http://localhost:3000/api/nylas/callback` as a callback URI in the Nylas dashboard. After the first Vercel deploy, add the production callback URL there too.

### 4. Fill in `.env.local`

If you don't already have a `.env.local`, copy `.env.example` to `.env.local` and fill in the values from steps 2-3. `ADMIN_EMAILS` is a comma-separated allowlist of emails allowed into `/admin` (e.g. `karin@foundernexus.com,you@foundernexus.com`).

Generate `SESSION_SECRET` (used to sign the admin session cookie) with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### 5. Set up the database

```bash
npm run db:generate   # generate SQL migration from schema.ts
npm run db:migrate    # apply it to your Neon database
npm run db:seed       # insert 4 editable test members (see src/db/seed.ts)
```

### 6. Run it

```bash
npm run dev
```

Visit `/connect` to link a test calendar, and `/admin` (with an email from `ADMIN_EMAILS`) to find a time and create a session.

## What this doesn't do (yet)

Member availability-window preferences, a visual free/busy week grid, session-cap enforcement, real auth, Nylas webhooks/RSVP sync, Zoom API integration, or email sending beyond the native calendar invites Nylas triggers. See the plan doc for the full deferred list.
