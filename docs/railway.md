# Railway

Action Hub runs as three services in the Railway project "Action Hub", beside a Railway Postgres
database (service `Postgres`, volume `postgres-volume`, 5000 MB). Every service runs one replica
in `europe-west4-drams3a` (EU West, Amsterdam). Their deploy settings live in
[`.railway/railway.ts`](../.railway/railway.ts) (Railway Infrastructure as Code). This page lists
what each service needs, so a standby host can match it ([standby-render.md](standby-render.md));
values are never written here.

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
| Volume         | `web-volume`, 500 MB, at `/data`: `scripts/pre-deploy-backup.ts` keeps the last week of pre-deploy dumps there                                                    |

Because the service mounts a volume, Railway never runs two of its deploys at once: the old
container stops before the new one starts, so every web deploy is a short outage (start-up runs
`seed-preview` and `migrate` before Next answers).

Variables set on the service:

- `DATABASE_URL`: also passed to the build, where `prisma generate` reads it
- `APP_URL`, `CRON_SECRET`, `RESEND_API_KEY`: the app refuses to start in production without them
- `FROM_EMAIL`, `REPLY_TO_EMAIL`, `GOOGLE_CLIENT_ID`, `ADMIN_EMAILS`
- `NEXT_PUBLIC_GA_MEASUREMENT_ID`: build time only, inlined into the client bundle
- `SENTRY_DSN`: build and runtime. Production only: without it (previews, the Render standby
  unless entered there) Sentry is never initialised. The build inlines it into the browser's
  settings and the CSP, so a change needs a redeploy
- `SENTRY_AUTH_TOKEN`: build time only, a Sentry organization token that uploads source maps;
  unset, the upload is skipped and the build still passes. `.railway/railway.ts` declares both,
  so set them here before the next `railway config plan`
- `ALLOW_DB_RESTORE`: only on the preview base environment, never production
- `BACKUP_B2_READ_KEY_ID`, `BACKUP_B2_READ_SECRET`, `BACKUP_AGE_IDENTITY`: only on the preview
  base environment, so `seed-preview` can restore the newest nightly backup. The read-only key
  is the bucket's, and the identity is a preview-only one, listed among the backup service's
  `BACKUP_AGE_RECIPIENTS` so it can be revoked alone. Without all three a preview gets the dev
  accounts only

Railway provides `PORT`, `RAILWAY_ENVIRONMENT_NAME`, `RAILWAY_GIT_COMMIT_SHA` (build and runtime;
the first names Sentry's environment, the second its release)
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
Variables: `CRON_SECRET` (the same value as the web app's) and `CRON_HEALTHCHECK_URL`, a
healthchecks.io ping URL that each run reports its start and result to. `trigger.mjs` also reads
`CRON_URL` (default `https://action.pauseai.info/api/cron/daily`); it is unset, and setting it
means adding it to `.railway/railway.ts` first (below).

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

A service with no Config File path still reads a `railway.toml` at the repository root, until the
file is gone from the commit it deploys. That file is the web app's, so **no service is deployed
between clearing its path and deploying the commit that deletes the TOMLs**: cron would build the
web `Dockerfile`. Scheduled cron runs reuse the image already built, so they are unaffected.

First merge the PR that adds `.railway/` and let it deploy as usual: the TOMLs still apply, so
nothing changes. Then, from an up-to-date checkout of `main`, do the rest in one sitting.

### 1. Preview base environment (dashboard)

`.railway/railway.ts` describes production only and refuses to run anywhere else: the preview
base environment holds `ALLOW_DB_RESTORE`, which an apply of this file would delete. For `web`
and (if it has one) `Cron for digest`, with no redeploy until step 4:

1. Set the settings first, while the TOML still overrides them: the builder to Dockerfile with
   the Dockerfile path, restart policy, healthcheck and draining from the web table above, and
   for cron `Dockerfile.cron`, restart Never and `0 * * * *`.
2. Clear the Config File path in the service settings.

### 2. Production (`railway config`)

`plan` refuses a service while its Config File path is set, so cutover comes before apply.

0. In a checkout of `main`: `npm ci`, and `railway --version` must be 5.75.0 or newer (the CLI
   whose plan logic this file was checked against). `railway link` to Action Hub, production,
   and pass no `-e`: the file reads the environment's name from the link. Turn off automatic
   deploys from `main` on `web` and `Cron for digest` (Settings > Source), keeping the repository
   connected. `plan` reads a missing `main` trigger as no change; if it shows a `source` change,
   the repository came disconnected, so reconnect it and plan again.
1. `railway config migrate status` lists the services still on a Config File path.
2. `railway config migrate cutover` clears those paths. It starts no deployment and leaves
   volumes alone. It saves the old paths to `.railway/.cac-migration.json` (gitignored), which
   `railway config migrate undo` needs: keep the same checkout and don't `git clean` it.
3. `railway config plan`. If it shows anything beyond the expected changes, run
   `railway config migrate undo`, turn autodeploy back on and stop.
4. `railway config apply`. Don't redeploy yet.

### 3. Delete the TOMLs

Merge the PR that deletes `railway.toml` and `railway.cron.toml`, and nothing else.

### 4. Deploy and check

1. Turn automatic deploys back on for production `web` and `Cron for digest`, and redeploy both
   on the deletion commit. Each web deploy is a short outage.
2. Check production: `/api/health` answers, both services show the settings above and no Config
   File path, and the next hourly cron run succeeds. `railway config plan` reports nothing to do.
3. Preview: close and reopen any PR environments (existing ones keep their old paths), then check
   one builds from the Dockerfile and seeds. A long `seed-preview` restore has to finish inside
   the healthcheck's 300s, so watch the first one.

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
`preserve()` in the same breath**, and to the standby's [`render.yaml`](../render.yaml) as
`sync: false` ([standby-render.md](standby-render.md)). Otherwise the next plan shows "Delete variable" for it: stop
there, add the name, and plan again. `.railway/railway.test.ts` lists the names, so it changes
alongside.
