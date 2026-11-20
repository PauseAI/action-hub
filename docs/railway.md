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
| Healthcheck    | `GET /api/health` (`SELECT 1`), Railway's default timeout: a deploy that can't reach the database is marked failed                                                |
| Restart policy | on failure, at most 3 retries                                                                                                                                     |
| Draining       | 10s between SIGTERM and SIGKILL, so Next exits cleanly instead of being marked CRASHED                                                                            |
| Domains        | `action.pauseai.info` (port 8080), and `catalyse.up.railway.app` (`proxy.ts` redirects its pages)                                                                 |
| Volume         | `web-volume`, 500 MB, at `/data`: `jobs/backup.ts` keeps the last week of dumps there                                                                             |

Because the service mounts a volume, Railway never runs two of its deploys at once: the old
container stops before the new one starts, so every web deploy is a short outage (start-up runs
`seed-preview` and `migrate` before Next answers).

Variables set on the service:

- `DATABASE_URL`: also passed to the build, where `prisma generate` reads it
- `APP_URL`, `CRON_SECRET`, `RESEND_API_KEY`: the app refuses to start in production without them
- `FROM_EMAIL`, `REPLY_TO_EMAIL`, `GOOGLE_CLIENT_ID`, `ADMIN_EMAILS`
- `B2_KEY_ID`, `B2_APP_KEY`, `B2_BUCKET_NAME`: the daily backup job's offsite copy, all or none
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
defaults to `https://action.pauseai.info/api/cron/daily`, and `CRON_HEALTHCHECK_URL`, a healthchecks.io
ping URL that each run reports its start and result to.

### Database backup (`backup`)

| Setting        | Value                                      |
| -------------- | ------------------------------------------ |
| Source         | image `ghcr.io/pauseai/backup-image:1.0.0` |
| Schedule       | `0 3 * * *` (03:00 UTC daily)              |
| Restart policy | never                                      |

Variables: `DATABASE_URL`, `BACKUP_NAME`, `BACKUP_AGE_RECIPIENTS`, `BACKUP_B2_BUCKET`,
`BACKUP_B2_KEY_ID`, `BACKUP_B2_SECRET`, `BACKUP_B2_REGION` and `BACKUP_HEALTHCHECK_URL`.

## Moving off Config as Code

Railway stops reading `railway.toml` and `railway.cron.toml` (Config as Code) on 2026-12-01.
Until then they override the dashboard for web and cron in every environment that has a Config
File path set, and what sits underneath is different: Railpack instead of the Dockerfiles (so no
`seed-preview`/`migrate` start-up), cron at `0 8 * * *`, no healthcheck, draining or retry limit.

### Production

`plan` refuses a service while its Config File path is set, so cutover comes before apply, and a
deploy in between would use the dashboard's settings. Do it in one sitting:

0. In a checkout of `main`: `npm ci`, and `railway --version` must be 5.75.0 or newer (the CLI
   whose plan logic this file was checked against). `railway link` to Action Hub, production.
   Then turn off automatic deploys from `main` on `web` and `Cron for digest` (Settings >
   Source), keeping the repository connected, so nothing deploys mid-way. `plan` reads a missing
   `main` trigger as no change; if it shows a `source` change, the repository came disconnected,
   so reconnect it and plan again.
1. `railway config migrate status` lists the services still on a Config File path.
2. `railway config migrate cutover` clears those paths. It starts no deployment and leaves
   volumes alone; `railway config migrate undo` puts them back.
3. `railway config plan`. If it shows anything beyond the expected changes, run
   `railway config migrate undo`, turn autodeploy back on and stop.
4. `railway config apply`, then redeploy web and cron.
5. Turn autodeploy back on for both services.
6. Once preview is switched over too, delete `railway.toml` and `railway.cron.toml` in a PR.
   Deleting them while any environment still has a path set fails that environment's next build.

### Preview

`.railway/railway.ts` describes production only and refuses to run anywhere else: the preview
base environment holds `ALLOW_DB_RESTORE`, which an apply of this file would delete. Preview is
set in the dashboard instead, and PR environments fork from it. In the preview base environment,
for `web` and (if it has one) `Cron for digest`:

1. Set the settings first, while the TOML still overrides them, so there is no gap: the builder
   to Dockerfile with the Dockerfile path, restart policy, healthcheck and draining from the web
   table above, and for cron `Dockerfile.cron`, restart Never and `0 * * * *`.
2. Clear the Config File path in the service settings.
3. Open or redeploy a PR environment and check it builds from the Dockerfile and seeds.

PR environments that already exist keep their own paths; close and reopen them after step 2.

## Changing a setting

Railway does not read `.railway/railway.ts` on deploy. Change it in a PR, then from a checkout
of `main` after `npm ci` (the SDK is pinned, so the graph is the one the tests checked), linked
to the project (`railway link`, production environment):

```bash
railway config plan    # read every line; it only reads Railway
railway config apply   # applies after confirming the same plan
```

Do not apply a plan that deletes a service, a variable or a volume. The file exports
`partial = "action-hub"`, so it owns only what it declares and leaves the database alone.

The plan compares every field of a declared service, so the file declares each service's source,
region, volume mount and full variable list as they are on Railway. Variables are `preserve()`.

**A variable added to a production service in the dashboard must be added to the file as
`preserve()` in the same breath.** Otherwise the next plan shows "Delete variable" for it: stop
there, add the name, and plan again. `.railway/railway.test.ts` lists the names, so it changes
alongside.
