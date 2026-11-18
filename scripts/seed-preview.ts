import { execSync } from 'child_process'
import { Client } from 'pg'
import { libpqUrl, resolveDbUrl } from '../lib/db-url'
import { logger } from '../lib/logger'

/**
 * Runs at container start, before migrations. Preview environments (Railway PR deploys) get
 * an anonymised copy of production so reviewers see realistic data. Only an empty database
 * is seeded: the container also restarts on failure and on every push to the PR, and
 * reviewers' changes should survive those. SEED_PREVIEW_FORCE=1 reseeds regardless.
 * Production, environments without the backup read key and age identity (see
 * scripts/fetch-prod-db.ts), and environments without ALLOW_DB_RESTORE=1 are left alone.
 */
const isProduction = process.env.RAILWAY_ENVIRONMENT_NAME === 'production'
const canReadBackups = Boolean(
  process.env.BACKUP_B2_READ_KEY_ID &&
  process.env.BACKUP_B2_READ_SECRET &&
  process.env.BACKUP_AGE_IDENTITY_FILE,
)

async function databaseIsEmpty(): Promise<boolean> {
  const client = new Client({ connectionString: libpqUrl(resolveDbUrl()) })
  await client.connect()
  try {
    const { rows } = await client.query<{ n: string }>(
      "SELECT count(*) AS n FROM pg_tables WHERE schemaname = 'public'",
    )
    return Number(rows[0].n) === 0
  } finally {
    await client.end()
  }
}

async function main(): Promise<void> {
  if (isProduction || !canReadBackups || process.env.ALLOW_DB_RESTORE !== '1') {
    logger.info(
      '[SEED-PREVIEW] Skipped (production, backup access not configured, or ALLOW_DB_RESTORE not set)',
    )
    return
  }
  if (process.env.SEED_PREVIEW_FORCE !== '1' && !(await databaseIsEmpty())) {
    logger.info('[SEED-PREVIEW] Skipped (database already has tables; set SEED_PREVIEW_FORCE=1)')
    return
  }
  execSync('npm run fetch-prod-db', { stdio: 'inherit' })
}

main().catch((err) => {
  logger.error(err, '[SEED-PREVIEW] Failed:')
  process.exit(1)
})
