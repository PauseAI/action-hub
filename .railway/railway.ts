// Railway Infrastructure as Code for the Action Hub project. Railway never reads this file on
// deploy: `railway config plan` diffs it against the linked environment and `railway config
// apply` writes the difference. docs/railway.md has the workflow and every service's settings.
//
// The named partial means this file owns only the services it declares. Anything else in the
// project (the Postgres database above all) is left alone when it is missing from here; without
// a partial, an apply would delete every resource this file leaves out.
//
// No service declares `source` or `env`, so the repository/image link and the variables stay
// exactly as they are in Railway; declaring `env` would make this file own the full list.
import { defineRailway, project, service } from 'railway/iac'

export const partial = 'action-hub'

// TODO(Harry): set each name to the service's name on the Railway canvas. A wrong name shows up
// in `railway config plan` as "Create service ...": stop and fix it rather than applying.
const WEB_SERVICE = 'catalyse'
const CRON_SERVICE = 'TODO-cron-service-name'
const BACKUP_SERVICE = 'TODO-backup-service-name'

export default defineRailway(() => {
  const web = service(WEB_SERVICE, {
    build: { builder: 'DOCKERFILE', dockerfilePath: 'Dockerfile' },
    deploy: {
      // No startCommand: the Dockerfile's CMD seeds previews, migrates, then starts Next.
      healthcheckPath: '/api/health',
      restartPolicyType: 'ON_FAILURE',
      restartPolicyMaxRetries: 3,
      // Railway gives 0s by default between SIGTERM and SIGKILL, so the old container is
      // force-killed before it can exit(0) and is marked CRASHED (a false alert email) on every
      // rolling deploy.
      drainingSeconds: 10,
      // TODO(Harry): copy from the dashboard if set (Settings > Deploy): region or replicas,
      // resource limits (limitOverride), and any volume mount (jobs/backup.ts keeps dumps on
      // RAILWAY_VOLUME_MOUNT_PATH when there is one). `railway config pull --json` prints them.
    },
  })

  const cron = service(CRON_SERVICE, {
    build: { builder: 'DOCKERFILE', dockerfilePath: 'Dockerfile.cron' },
    deploy: {
      restartPolicyType: 'NEVER',
      // Hourly: /api/cron/daily runs each job when it is due (lib/cron-jobs.ts).
      cronSchedule: '0 * * * *',
    },
  })

  // Runs ghcr.io/pauseai/backup-image. Its source and variables are set in the dashboard.
  const backup = service(BACKUP_SERVICE, {
    deploy: {
      restartPolicyType: 'NEVER',
      // 03:00 UTC daily.
      cronSchedule: '0 3 * * *',
      // TODO(Harry): copy region, resource limits and any volume mount from the dashboard.
    },
  })

  // TODO(Harry): set to the Railway project's name as `railway config pull` prints it.
  return project('TODO-project-name', { resources: [web, cron, backup] })
})
