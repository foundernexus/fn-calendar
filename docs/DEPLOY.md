# Deploying

Push to `main`. Vercel builds and promotes to production.

## Migrations run inside the build, on purpose

`vercel.json` sets:

```
if [ "$VERCEL_ENV" = production ]; then npm run db:migrate; fi && next build
```

Two things follow from that, and both are the point.

**The order can't be wrong any more.** On 2026-08-21 a deploy went out carrying
code that read three columns the database didn't have yet, and every page
touching members returned 500 until the migration was run by hand. The commit
said "needs db:migrate" — a note in a commit message is not a mechanism.
Migrating first, in the same step that builds, is.

**A failed migration fails the build.** Nothing is promoted, and the previous
deployment keeps serving. That is the safe direction: deploys stop until
somebody looks, rather than a deployment going live against a database it
doesn't understand.

## Why only production

Preview deployments share `DATABASE_URL` with production — there is one Neon
database, not one per environment. Without the `VERCEL_ENV` guard, opening a
pull request would migrate the live database.

## What this does not cover

**Rolling back a deployment does not roll back a migration.** Vercel's
"Promote to production" on an older build restores the code, not the schema.
This is safe as long as migrations stay additive (`ADD COLUMN` with a default,
new tables) — old code ignores a column it doesn't know about. A migration that
drops or renames something breaks that property, and the rollback with it.

**Two production deploys at once could race.** Rare enough to accept; if it
ever bites, the symptom is a failed build rather than a corrupted schema.

## Doing it by hand

Still works, and is still the right move when you want to migrate without
shipping code:

```
npm run db:migrate
```

Reads `DATABASE_URL` from `.env.local`, which points at the production
database. There is no separate development database — a local migration is a
production migration.
