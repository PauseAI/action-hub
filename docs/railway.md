# Railway

Action Hub runs as three services in the Railway project "Action Hub", beside a Railway Postgres
database (service `Postgres`, volume `postgres-volume`, 5000 MB). Every service runs one replica
in `europe-west4-drams3a` (EU West, Amsterdam). Their deploy settings live in
[`.railway/railway.ts`](../.railway/railway.ts) (Railway Infrastructure as Code). This page lists
what each service needs, so a standby host can match it; values are never written here.

## Services

### Web app (`web`)

| Setting        | Value                                                                                                                                                             |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Source         | this repository, `main`, GitHub autodeploy                                                                                                                        |
| Build          | `Dockerfile`                                                                                                                                                      |
| Start          | no custom start command; the Dockerfile's `CMD`: `npm run seed-preview && npm run migrate && exec node_modules/.bin/next start` (`exec`, so SIGTERM reaches Next) |
| Healthcheck    | `GET /api/health` (runs `SELECT 1` against the database), Railway's default timeout                                                                               |
| Restart policy | on failure, at most 3 retries                                                                                                                                     |
| Draining       | 10s between SIGTERM and SIGKILL, so the old container exits cleanly on a rolling deploy                                                                           |
| Domains        | `action.pauseai.info` (port 8080), and `catalyse.up.railway.app` (`proxy.ts` redirects its pages)                                                                 |
| Volume         | `web-volume`, 500 MB, at `/data`: `jobs/backup.ts` keeps the last week of dumps there                                                                             |

Variables set on the service:

- `DATABASE_URL`: also passed to the build, where `prisma generate` reads it
- `APP_URL`, `CRON_SECRET`, `RESEND_API_KEY`: the app refuses to start in production without them
- `FROM_EMAIL`, `REPLY_TO_EMAIL`, `GOOGLE_CLIENT_ID`, `ADMIN_EMAILS`
- `B2_KEY_ID`, `B2_APP_KEY`, `B2_BUCKET_NAME`: the hourly backup job's offsite copy, all or none
- `NEXT_PUBLIC_GA_MEASUREMENT_ID`: build time only, inlined into the client bundle
- `ALLOW_DB_RESTORE`: only on the preview base environment, never production

Railway provides `PORT`, `RAILWAY_ENVIRONMENT_NAME`, `RAILWAY_GIT_COMMIT_SHA` (build and runtime)
and, when a volume is mounted, `RAILWAY_VOLUME_MOUNT_PATH`; a standby host has to set the ones
the app reads. The production checks in `validateEnv` (`lib/env.ts`) run when
`RAILWAY_ENVIRONMENT_NAME` is `production` or unset; any other value turns them off.
`STUB_EMAIL`, `STUB_GOOGLE` and `DISABLE_RATE_LIMIT` must be unset in production.

### Cron trigger (`Cron for digest`)

| Setting        | Value                                                           |
| -------------- | --------------------------------------------------------------- |
| Source         | this repository, `main`                                         |
| Build          | `Dockerfile.cron` (Node and `scripts/cron-trigger/trigger.mjs`) |
| Schedule       | `0 * * * *` (hourly, UTC)                                       |
| Restart policy | never                                                           |

No custom start command: `Dockerfile.cron`'s `CMD` runs `trigger.mjs`. A Custom Start Command
in the dashboard overrides it (`.railway/railway.ts` cannot clear one), and a stale one once
made every hourly run die at once with no logs.

It POSTs to `/api/cron/daily`, which runs each job in `lib/cron-jobs.ts` when it is due.
Variables: `CRON_SECRET` (the same value as the web app's), optionally `CRON_URL`, which
defaults to `https://action.pauseai.info/api/cron/daily`, and `CRON_HEALTHCHECK_URL`, a
dead-man ping that `trigger.mjs` reads once the cron-healthcheck change is merged.

### Database backup (`backup`)

| Setting        | Value                                      |
| -------------- | ------------------------------------------ |
| Source         | image `ghcr.io/pauseai/backup-image:1.0.0` |
| Schedule       | `0 3 * * *` (03:00 UTC daily)              |
| Restart policy | never                                      |

Variables: `DATABASE_URL`, `BACKUP_NAME`, `BACKUP_AGE_RECIPIENTS`, `BACKUP_B2_BUCKET`,
`BACKUP_B2_KEY_ID`, `BACKUP_B2_SECRET`, `BACKUP_B2_REGION` and `BACKUP_HEALTHCHECK_URL`.

## Moving off Config as Code

The web and cron services also still read `railway.toml` and `railway.cron.toml` (Config as
Code), which Railway stops reading on 2026-12-01. `plan` refuses a service while its Config
File path is set, so switch them over in this order:

1. `railway config migrate status` lists the services still on a Config File path.
2. `railway config migrate cutover` clears those paths. It starts no deployment and leaves
   volumes alone; `railway config migrate undo` puts them back.
3. `railway config plan`, then `railway config apply` (below), then redeploy web and cron.
4. Only then delete `railway.toml` and `railway.cron.toml` in a PR. Deleting them while a path
   is still set fails the next build.

## Changing a setting

Railway does not read `.railway/railway.ts` on deploy. Change it in a PR, then from a checkout
linked to the project (`railway link`, production environment):

```bash
railway config plan    # read every line; it only reads Railway
railway config apply   # applies after confirming the same plan
```

Do not apply a plan that deletes a service, a variable or a volume. The file exports
`partial = "action-hub"`, so it owns only what it declares and leaves the database alone.

The plan compares every field of a declared service, so the file declares each service's source,
region, volume mount and full variable list as they are on Railway. Variables are `preserve()`:
a variable added in the dashboard but not here shows in `plan` as a destructive "Delete
variable", so add its name to the file first. The file
describes production; don't apply it to another environment.
