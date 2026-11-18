# Railway

Action Hub runs as three services in one Railway project, beside a Railway Postgres database.
Their deploy settings live in [`.railway/railway.ts`](../.railway/railway.ts) (Railway
Infrastructure as Code). This page lists what each service needs, so a standby host can match
it; values are never written here.

## Services

### Web app

| Setting        | Value                                                                                                    |
| -------------- | -------------------------------------------------------------------------------------------------------- |
| Source         | this repository, GitHub autodeploy                                                                       |
| Build          | `Dockerfile`                                                                                             |
| Start          | no custom start command; the Dockerfile's `CMD`: `npm run seed-preview && npm run migrate && next start` |
| Healthcheck    | `GET /api/health` (runs `SELECT 1` against the database)                                                 |
| Restart policy | on failure, at most 3 retries                                                                            |
| Draining       | 10s between SIGTERM and SIGKILL, so the old container exits cleanly on a rolling deploy                  |
| Domains        | `action.pauseai.info`, and `catalyse.up.railway.app` (`proxy.ts` redirects its pages)                    |

Variables set on the service:

- `DATABASE_URL`: also passed to the build, where `prisma generate` reads it
- `APP_URL`, `CRON_SECRET`, `RESEND_API_KEY`: the app refuses to start in production without them
- `FROM_EMAIL`, `REPLY_TO_EMAIL`, `GOOGLE_CLIENT_ID`, `ADMIN_EMAILS`
- `B2_KEY_ID`, `B2_APP_KEY`, `B2_BUCKET_NAME`: the hourly backup job's offsite copy, all or none
- `NEXT_PUBLIC_GA_MEASUREMENT_ID`: build time only, inlined into the client bundle
- `ALLOW_DB_RESTORE`: only on the preview base environment, never production

Railway provides `PORT`, `RAILWAY_ENVIRONMENT_NAME`, `RAILWAY_GIT_COMMIT_SHA` (build and runtime)
and, when a volume is mounted, `RAILWAY_VOLUME_MOUNT_PATH`; a standby host has to set the ones
the app reads (`RAILWAY_ENVIRONMENT_NAME=production` keeps the production checks on).
`STUB_EMAIL`, `STUB_GOOGLE` and `DISABLE_RATE_LIMIT` must be unset in production.

### Cron trigger

| Setting        | Value                                                           |
| -------------- | --------------------------------------------------------------- |
| Source         | this repository                                                 |
| Build          | `Dockerfile.cron` (Node and `scripts/cron-trigger/trigger.mjs`) |
| Schedule       | `0 * * * *` (hourly, UTC)                                       |
| Restart policy | never                                                           |

No custom start command: `Dockerfile.cron`'s `CMD` runs `trigger.mjs`. A Custom Start Command
in the dashboard overrides it (`.railway/railway.ts` cannot clear one), and a stale one once
made every hourly run die at once with no logs.

It POSTs to `/api/cron/daily`, which runs each job in `lib/cron-jobs.ts` when it is due.
Variables: `CRON_SECRET` (the same value as the web app's), optionally `CRON_URL`, which
defaults to `https://action.pauseai.info/api/cron/daily`, and `CRON_HEALTHCHECK_URL`.

### Database backup

| Setting        | Value                                |
| -------------- | ------------------------------------ |
| Source         | image `ghcr.io/pauseai/backup-image` |
| Schedule       | `0 3 * * *` (03:00 UTC daily)        |
| Restart policy | never                                |

Its variables are set in the Railway dashboard only; their names are not recorded in this
repository yet.

## Changing a setting

Railway does not read `.railway/railway.ts` on deploy. Change it in a PR, then from a checkout
linked to the project (`railway link`, production environment):

```bash
railway config plan    # read every line; it only reads Railway
railway config apply   # applies after confirming the same plan
```

Do not apply a plan that deletes a service, a variable or a volume. The file exports
`partial = "action-hub"`, so it owns only the services it declares and leaves the database
alone. It declares no `source` or `env`, so repository links and variables are managed in the
dashboard.
