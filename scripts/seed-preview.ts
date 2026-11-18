import { execSync } from 'child_process'
import { Client } from 'pg'
import { libpqUrl, resolveDbUrl } from '../lib/db-url'
import { logger } from '../lib/logger'
import { claimDisposable } from './disposable-db'
import { seedDevAccounts } from './seed-dev-accounts'

/**
 * Runs at container start, before migrations. Preview environments (Railway PR deploys) with
 * ALLOW_DB_RESTORE=1 get an anonymised copy of production so reviewers see realistic data, or,
 * where the backup read key and age identity are not set (see scripts/fetch-prod-db.ts), just
 * the migrated schema and the dev accounts, so reviewers can still sign in. Only an empty
 * database is seeded: the container also restarts on failure and on every push to the PR, and
 * reviewers' changes should survive those. SEED_PREVIEW_FORCE=1 reseeds regardless.
 * Production is left alone.
 */
const isProduction = process.env.RAILWAY_ENVIRONMENT_NAME === 'production'
const canReadBackups = Boolean(
  process.env.BACKUP_B2_READ_KEY_ID &&
  process.env.BACKUP_B2_READ_SECRET &&
  process.env.BACKUP_AGE_IDENTITY_FILE,
)

async function withClient<T>(fn: (db: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: libpqUrl(resolveDbUrl()) })
  await client.connect()
  try {
    return await fn(client)
  } finally {
    await client.end()
  }
}

async function databaseIsEmpty(): Promise<boolean> {
  return withClient(async (db) => {
    const { rows } = await db.query<{ n: string }>(
      "SELECT count(*) AS n FROM pg_tables WHERE schemaname = 'public'",
    )
    return Number(rows[0].n) === 0
  })
}

/** Marks the (empty) database disposable, migrates it, and seeds the dev accounts. */
async function seedDevAccountsOnly(): Promise<void> {
  await withClient((db) => claimDisposable(db, 'seed dev accounts into it'))
  execSync('npx prisma migrate deploy', {
    stdio: 'inherit',
    env: { ...process.env, CHECKPOINT_DISABLE: '1' },
  })
  await withClient((db) => seedDevAccounts(db))
}

async function main(): Promise<void> {
  if (isProduction || process.env.ALLOW_DB_RESTORE !== '1') {
    logger.info('[SEED-PREVIEW] Skipped (production, or ALLOW_DB_RESTORE not set)')
    return
  }
  if (process.env.SEED_PREVIEW_FORCE !== '1' && !(await databaseIsEmpty())) {
    logger.info('[SEED-PREVIEW] Skipped (database already has tables; set SEED_PREVIEW_FORCE=1)')
    return
  }
  if (canReadBackups) {
    execSync('npm run fetch-prod-db', { stdio: 'inherit' })
    return
  }
  logger.info('[SEED-PREVIEW] No backup access configured: seeding dev accounts only')
  await seedDevAccountsOnly()
}

main().catch((err) => {
  logger.error(err, '[SEED-PREVIEW] Failed:')
  process.exit(1)
})
