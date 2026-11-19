// Railway Infrastructure as Code for the Action Hub project. Railway never reads this file on
// deploy: `railway config plan` diffs it against the linked environment and `railway config
// apply` writes the difference. docs/railway.md has the workflow and every service's settings.
//
// The named partial means this file owns only what it declares. The Postgres database and its
// volume are left alone; without a partial, an apply would delete every resource left out.
//
// The plan compares each declared service field by field, so a source, variable list or volume
// mount left out here reads as "remove it". Each one is declared as it is on Railway, and
// variables are `preserve()`, so their values stay in Railway and never appear in this file.
// Domains and other networking keys are a sparse patch: left out, they stay as they are.
import { defineRailway, github, image, preserve, project, service, volume } from 'railway/iac'

export const partial = 'action-hub'

const REPO = 'PauseAI/action-hub'
// Railway's europe-west4 (Amsterdam). Declared so a deploy update cannot move a service.
const REGION = 'europe-west4-drams3a'

export default defineRailway(() => {
  const webVolume = volume('web-volume', { region: REGION, sizeMB: 500 })

  const web = service('web', {
    source: github(REPO, { branch: 'main' }),
    build: { builder: 'DOCKERFILE', dockerfilePath: 'Dockerfile' },
    replicas: { [REGION]: 1 },
    deploy: {
      // No startCommand: the Dockerfile's CMD seeds previews, migrates, then starts Next. A
      // dashboard Custom Start Command would still override it (see the cron service).
      // Railway's default timeout: start-up runs migrations before Next answers.
      healthcheckPath: '/api/health',
      restartPolicyType: 'ON_FAILURE',
      restartPolicyMaxRetries: 3,
      // Railway gives 0s by default between SIGTERM and SIGKILL, so the old container is
      // force-killed before it can exit(0) and is marked CRASHED (a false alert email) on every
      // rolling deploy.
      drainingSeconds: 10,
    },
    // jobs/backup.ts keeps the last week of dumps here (RAILWAY_VOLUME_MOUNT_PATH).
    volumeMounts: { '/data': webVolume },
    env: {
      ADMIN_EMAILS: preserve(),
      APP_URL: preserve(),
      B2_APP_KEY: preserve(),
      B2_BUCKET_NAME: preserve(),
      B2_KEY_ID: preserve(),
      CRON_SECRET: preserve(),
      DATABASE_URL: preserve(),
      FROM_EMAIL: preserve(),
      GOOGLE_CLIENT_ID: preserve(),
      NEXT_PUBLIC_GA_MEASUREMENT_ID: preserve(),
      REPLY_TO_EMAIL: preserve(),
      RESEND_API_KEY: preserve(),
    },
  })

  const cron = service('Cron for digest', {
    source: github(REPO, { branch: 'main' }),
    build: { builder: 'DOCKERFILE', dockerfilePath: 'Dockerfile.cron' },
    replicas: { [REGION]: 1 },
    deploy: {
      // No startCommand: Dockerfile.cron's CMD runs trigger.mjs. The SDK drops a null start
      // command, so this file cannot clear a dashboard Custom Start Command; check it is empty.
      restartPolicyType: 'NEVER',
      // Hourly: /api/cron/daily runs each job when it is due (lib/cron-jobs.ts).
      cronSchedule: '0 * * * *',
    },
    env: {
      CRON_HEALTHCHECK_URL: preserve(),
      CRON_SECRET: preserve(),
    },
  })

  const backup = service('backup', {
    source: image('ghcr.io/pauseai/backup-image:1.0.0'),
    replicas: { [REGION]: 1 },
    deploy: {
      restartPolicyType: 'NEVER',
      // 03:00 UTC daily.
      cronSchedule: '0 3 * * *',
    },
    env: {
      BACKUP_AGE_RECIPIENTS: preserve(),
      BACKUP_B2_BUCKET: preserve(),
      BACKUP_B2_KEY_ID: preserve(),
      BACKUP_B2_REGION: preserve(),
      BACKUP_B2_SECRET: preserve(),
      BACKUP_HEALTHCHECK_URL: preserve(),
      BACKUP_NAME: preserve(),
      DATABASE_URL: preserve(),
    },
  })

  return project('Action Hub', { resources: [web, webVolume, cron, backup] })
})
