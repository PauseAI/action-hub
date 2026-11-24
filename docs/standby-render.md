# Standby host on Render

If Railway goes down for longer than we can wait, Action Hub can run on Render, in Frankfurt.
Nothing exists on Render until it is needed: a failover, or a rehearsal of one, creates it from
the Blueprint [`render.yaml`](../render.yaml) in this repository, fills it from the newest
nightly backup and, at a real failover, moves `action.pauseai.info` to it. This page is the
runbook. It is written so a deputy can follow it alone; Harry decides when to fail over and
joins for the failback.

> [!WARNING]
> **A rehearsal must never be able to email members.** It runs on a real copy of members' data,
> so any email it sent would reach real people. In a rehearsal:
>
> - leave `RESEND_API_KEY` **empty**, and set `RAILWAY_ENVIRONMENT_NAME` to `rehearsal`, which
>   lets the app start without an email key. With no key the app logs each email as
>   `[EMAIL NOT CONFIGURED] Would send to ...` and drops it;
> - never add `EMAIL_PROVIDER`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` or any other email
>   setting to the Render services;
> - leave `CRON_HEALTHCHECK_URL` empty, so production's healthcheck never hears from it;
> - don't touch DNS;
> - delete everything on Render the same day (step R4).
>
> At a real failover the email key is set, and some members may get an email twice (a digest
> or reminder that Railway sent after the backup was taken). That is accepted.

## What the standby is

`render.yaml` declares three resources, all in Frankfurt:

| Render resource  | Railway counterpart | What it runs                                                                                                                   |
| ---------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `actionhub-web`  | `web`               | the same `Dockerfile`; start-up migrates the database, then starts Next. Health check `GET /api/health`                        |
| `actionhub-cron` | `Cron for digest`   | the same `Dockerfile.cron`, hourly at minute 0 (UTC): `trigger.mjs` POSTs to `/api/cron/daily`                                 |
| `actionhub-db`   | `Postgres`          | Postgres 18, 5 GB. Render keeps its own point-in-time recovery for paid databases, so no backup service runs during a failover |

The web service generates its own `CRON_SECRET`, and the cron service reads it from there, so
there is no secret to copy for it. It also means Railway's cron, if Railway comes back while
`action.pauseai.info` points at Render, is refused rather than running jobs twice.

`.railway/render.test.ts` checks that the Blueprint stays in step with `.railway/railway.ts`: same
Dockerfiles, health check, schedule, and the same variable names. **A variable added to
production on Railway has to be added to `render.yaml` as well**, or that test fails.

Costs run only while the resources exist: a web service (`1c-2g`), a cron job billed per
run-minute, and a database (`0.5c-1g`, 5 GB).

## Before you start

You need:

- A Render account in PauseAI's Render workspace, with the Render GitHub app allowed to read
  `PauseAI/action-hub`.
- For a real failover, access to the `pauseai.info` zone in Cloudflare.
- Psono access to the entries below.
- A computer with Node 24 and a checkout of this repository's `main`, with `npm ci` and
  `pg_restore` 18 or newer: `pg_restore --version` says which. On a Mac, `npm run install:pg-tools`
  installs it; on Linux, install `postgresql-client-18` from https://www.postgresql.org/download/.

The values to enter, from Psono:

| Variable                        | Service | Failover                                                          | Rehearsal                                                |
| ------------------------------- | ------- | ----------------------------------------------------------------- | -------------------------------------------------------- |
| `RAILWAY_ENVIRONMENT_NAME`      | web     | `production`                                                      | `rehearsal`                                              |
| `APP_URL`                       | web     | `https://action.pauseai.info`                                     | the web service's `onrender.com` URL (step 3)            |
| `RESEND_API_KEY`                | web     | production's Resend key                                           | **empty**                                                |
| `FROM_EMAIL`                    | web     | production's                                                      | production's                                             |
| `REPLY_TO_EMAIL`                | web     | production's                                                      | production's                                             |
| `GOOGLE_CLIENT_ID`              | web     | production's                                                      | production's (Google sign-in won't work on onrender.com) |
| `ADMIN_EMAILS`                  | web     | production's                                                      | production's                                             |
| `NEXT_PUBLIC_GA_MEASUREMENT_ID` | web     | production's                                                      | **empty**, so the rehearsal isn't counted                |
| `CRON_URL`                      | cron    | the web service's `onrender.com` URL + `/api/cron/daily` (step 3) | the same                                                 |
| `CRON_HEALTHCHECK_URL`          | cron    | production's healthchecks.io ping URL (step 3)                    | **empty**                                                |

`RAILWAY_ENVIRONMENT_NAME` is what the app reads to know it is the live deployment. Set to
`production`, the app refuses to start without its email key and the other production settings,
and the scripts that wipe or anonymise a database refuse to run against it. Set to anything else,
those checks are off.

For the restore (step 4) you also need, from Psono: the bucket's read-only key,
"actionhub-backup-read", and Action Hub's age identity, "Action Hub - Object Storage (R2, B2,
S3) Backup Encryption Key".

## Failover

Write down the time you start each step; it tells us how long a failover takes.

### 1. Create the services from the Blueprint

1. In the Render dashboard, **New > Blueprint**, pick `PauseAI/action-hub` and branch `main`.
   Name it "Action Hub standby".
2. Render reads `render.yaml` and asks for every variable marked `sync: false`. Enter the
   **Failover** column of the table above, but leave `CRON_URL` and `CRON_HEALTHCHECK_URL`
   empty for now.
3. **Apply.** Render creates the database, then builds and deploys the web service (about ten
   minutes; the build compiles the whole app). Its first start migrates the empty database.

Render only asks for these values when the Blueprint is created. To change one later, edit it on
the service's **Environment** page.

### 2. Hold the cron job

Open `actionhub-cron` and **Suspend** it, so no job runs while the database is being filled.

### 3. Point the cron job at the web service

Open `actionhub-web`. Its URL is at the top of the page, such as
`https://actionhub-web.onrender.com` (Render may add a suffix). On `actionhub-cron`'s
**Environment** page set `CRON_URL` to that URL followed by `/api/cron/daily`, set
`CRON_HEALTHCHECK_URL` (failover only), and save.

From then on the cron job calls the web service directly, so it never depends on DNS, and never
reaches Railway's copy of the app if Railway comes back. Before this step, a run that slips in
calls `action.pauseai.info` with the standby's own secret: Railway refuses it, and with no
healthcheck URL set it reports nowhere.

### 4. Restore the newest backup

1. On `actionhub-db`, **Connect > External**, copy the **External Database URL**.
2. Save the age identity from Psono to a file outside the repository, readable only by you
   (`chmod 600`).
3. Make a file outside the repository, say `~/standby.env`, also `chmod 600`:

   ```bash
   RESTORE_DATABASE_URL=<External Database URL>
   BACKUP_AGE_IDENTITY_FILE=/path/to/the/identity/file
   BACKUP_B2_READ_KEY_ID=<keyID from "actionhub-backup-read">
   BACKUP_B2_READ_SECRET=<applicationKey from "actionhub-backup-read">
   ```

4. In the checkout of `main`:

   ```bash
   npm run restore-standby -- --env ~/standby.env
   ```

   It prints the backup it chose, such as `backups/actionhub-2026-11-24_030012.dump.age`: the
   standby holds everything up to that time (the nightly backup runs at 03:00 UTC). Anything
   written on Railway after it is lost unless Railway's database can be recovered later; note the
   time for the announcement.

   It warns if the backup is more than two days old (the nightly backup has been failing). It
   refuses a database that already holds volunteers, so it can't overwrite a standby in use or
   production. If it fails partway, it empties the standby again and can simply be run again.
   If it says it could not empty the standby, empty it by hand and run it again:
   `psql "<External Database URL>" -c 'DROP SCHEMA public CASCADE; CREATE SCHEMA public'`. This
   erases the standby's database, so never run it once the standby is serving members.

5. Close the database to the internet: on `actionhub-db`, **Access Control**, delete the entry
   that allows `0.0.0.0/0`. The web and cron services connect over Render's private network and
   are unaffected. It now holds every member's data, so only re-open it, to your own IP, when a
   step needs it (the failback).
6. Delete `~/standby.env` and the identity file.

### 5. Restart the web service and check it

1. On `actionhub-web`, **Manual Deploy > Restart service**. Start-up applies any migration newer
   than the backup. In **Logs**, look for `prisma migrate deploy` finishing and Next starting.
2. Open `<onrender.com URL>/api/health`: it answers `{"ok":true}`.
3. Open the `onrender.com` URL in a browser; the home page loads. (Google sign-in only works on
   `action.pauseai.info`, so sign-in is checked in step 7.)

### 6. Resume the cron job

On `actionhub-cron`, **Resume**, then **Trigger Run**. Its log should end with `HTTP 200` and the
jobs' results, and healthchecks.io shows the run.

### 7. Move `action.pauseai.info` to Render

1. On `actionhub-web`, **Settings > Custom Domains > Add**: `action.pauseai.info`. Render shows
   the `onrender.com` hostname to point it at.
2. In Cloudflare, `pauseai.info` > **DNS > Records**, find the `action` record. **Write down its
   current target and proxy status**: the failback puts them back.
3. Edit it: type `CNAME`, target the `onrender.com` hostname, proxy status **DNS only** (grey
   cloud), so Render can issue a certificate. Delete any `AAAA` record for `action`.
4. Back on Render, **Verify**. Once the certificate shows as issued (usually a few minutes), you
   may set the Cloudflare record back to the proxy status you wrote down.
5. Check `https://action.pauseai.info/api/health` answers `{"ok":true}`, sign in with Google,
   and open a page with data on it.

Tell Harry and the team that Action Hub is on the standby, and from what time data was lost.

## Failback

Do this with Harry, once Railway is healthy again: `https://catalyse.up.railway.app/api/health`
answers. It replaces Railway's database, which is still as it was when Railway went down, with
everything written on Render since the failover. Pick a quiet time; Action Hub is offline for a
few minutes.

You need `pg_dump` and `pg_restore` 18 (see [Before you start](#before-you-start)), the Render
database's External Database URL, with your own IP added to its **Access Control**, and Railway's
public database URL (Railway > `Postgres` > **Variables** > `DATABASE_PUBLIC_URL`).

1. **Stop writes on Render.** Suspend `actionhub-cron`. On `actionhub-web`, **Settings >
   Maintenance Mode** on.
2. **Copy the data across.** Keep a copy of Railway's database as it is first, then restore
   Render's over it. `--single-transaction` means a failed restore changes nothing. `read -rs`
   asks for each URL without echoing it or keeping it in the shell's history.

   ```bash
   read -rs RAILWAY_URL; export RAILWAY_URL
   read -rs RENDER_URL; export RENDER_URL
   pg_dump --format=custom --file railway-before-failback.dump "$RAILWAY_URL"
   pg_dump --format=custom --no-owner --no-privileges --file render-final.dump "$RENDER_URL"
   pg_restore --clean --if-exists --no-owner --no-privileges --single-transaction --exit-on-error \
     --dbname "$RAILWAY_URL" render-final.dump
   ```

3. **Restart Railway's web service** (it applies any migration that ran on Render only), and
   check `https://catalyse.up.railway.app/api/health`.
4. **Move the domain back.** In Cloudflare, set the `action` record back to the target and proxy
   status written down in failover step 7. Remove `action.pauseai.info` from `actionhub-web`'s
   Custom Domains. Check `https://action.pauseai.info/api/health`, and sign in.
5. **Let Railway's cron run.** It runs on its own schedule; check the next hourly run on
   healthchecks.io.
6. **Delete the standby** once Railway has run for a day: on Render, delete `actionhub-web`,
   `actionhub-cron`, `actionhub-db` and then the Blueprint. Delete both dump files: they hold
   every member's personal data in plain text.

## Rehearsal

A rehearsal runs the failover up to the DNS switch, against a real backup, then deletes
everything. Run one after any change to `render.yaml`, the Dockerfiles or the backup format,
and at least twice a year. **Read the warning at the top of this page first.**

- **R1.** Failover steps 1 to 3 with the **Rehearsal** column of the table: `RESEND_API_KEY`,
  `NEXT_PUBLIC_GA_MEASUREMENT_ID` and `CRON_HEALTHCHECK_URL` empty, `RAILWAY_ENVIRONMENT_NAME`
  `rehearsal`. Enter `APP_URL` after the web service exists, on its **Environment** page, as its
  `onrender.com` URL, so links point at the rehearsal.
- **R2.** Failover steps 4 to 6. After the cron run, the web service's logs show each email the
  jobs would have sent as `[EMAIL NOT CONFIGURED] Would send to ...`: with no key, nothing
  leaves. Sign-in is not checked, since Google refuses the `onrender.com` origin.
- **R3.** Skip step 7: don't touch Cloudflare.
- **R4.** The same day, delete `actionhub-web`, `actionhub-cron`, `actionhub-db` and the
  Blueprint, then `~/standby.env` and the identity file. Write down how long each step took
  and anything in this page that was wrong or unclear, and send it to Harry.
