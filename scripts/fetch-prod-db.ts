#!/usr/bin/env node
/**
 * Restores the latest prod backup (scripts/prod-backup.ts) into the database at DATABASE_URL,
 * migrates it to this checkout's schema (the scrub names every current column, and the backup can
 * predate the newest migrations), then anonymises it and seeds the dev accounts
 * (scripts/anonymise-db.ts). If the migration or the scrub fails the database is emptied again,
 * so raw prod data never outlives it. Refuses to touch the production environment.
 *
 * Needs an age identity (BACKUP_AGE_IDENTITY_FILE, or BACKUP_AGE_IDENTITY; see readAgeIdentity),
 * and to download, BACKUP_B2_READ_KEY_ID and BACKUP_B2_READ_SECRET (BACKUP_B2_BUCKET optional),
 * from the environment or the env file.
 *
 * Usage:
 *   npx tsx scripts/fetch-prod-db.ts                       # reads variables from .env.backup
 *   npx tsx scripts/fetch-prod-db.ts --env /path/to/env
 *   npx tsx scripts/fetch-prod-db.ts --file actionhub-<time>.dump.age   # a dump already downloaded
 */

import { readFileSync, rmSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { Client } from 'pg'
import { libpqUrl, loadEnvFile, resolveDbUrl } from '../lib/db-url'
import { logger } from '../lib/logger'
import { anonymise } from './anonymise-db'
import { seedDevAccounts } from './seed-dev-accounts'
import { claimDisposable } from './disposable-db'
import {
  decryptDump,
  downloadNewestDump,
  readAgeIdentity,
  restoreIntoEmptySchema,
} from './prod-backup'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')

// ── CLI args ──────────────────────────────────────────────────────────────────

const args = process.argv.slice(2)
const flag = (name: string) => {
  const i = args.indexOf(name)
  return i === -1 ? undefined : args[i + 1]
}
const envFile = flag('--env') ?? resolve(ROOT, '.env.backup')
const localDump = flag('--file')

// ── Restore ───────────────────────────────────────────────────────────────────

async function emptyDatabase(dbUrl: string): Promise<void> {
  const client = new Client({ connectionString: dbUrl })
  await client.connect()
  try {
    await claimDisposable(client, 'restore over it')
    await client.query('DROP SCHEMA IF EXISTS public CASCADE')
    await client.query('CREATE SCHEMA public')
  } finally {
    await client.end()
  }
}

async function anonymiseDatabase(dbUrl: string): Promise<void> {
  const client = new Client({ connectionString: dbUrl })
  await client.connect()
  try {
    await anonymise(client)
    await seedDevAccounts(client)
  } finally {
    await client.end()
  }
}

/** Empties the public schema and restores the dump into it. */
export async function restoreDump(dump: Uint8Array, dbUrl: string): Promise<void> {
  await emptyDatabase(dbUrl)
  restoreIntoEmptySchema(dump, dbUrl)
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  loadEnvFile(envFile)

  // The restore empties the target database first; nothing may ever point this at prod.
  if (process.env.RAILWAY_ENVIRONMENT_NAME === 'production') {
    logger.error('Refusing to run in the production environment')
    process.exit(1)
  }

  // Any Railway environment must opt in, so a fork of production cannot wipe its database
  // by accident. Only preview environments set this.
  if (process.env.RAILWAY_ENVIRONMENT_NAME && process.env.ALLOW_DB_RESTORE !== '1') {
    logger.error('Refusing to restore: set ALLOW_DB_RESTORE=1 to allow it in this environment')
    process.exit(1)
  }

  const identity = readAgeIdentity()
  if (!identity) {
    logger.error(
      `BACKUP_AGE_IDENTITY_FILE must name a file holding Action Hub's age identity (Psono: "Action Hub - Object Storage (R2, B2, S3) Backup Encryption Key"), or BACKUP_AGE_IDENTITY hold an identity the dumps are encrypted to. Add one to '${envFile}' or export it.`,
    )
    process.exit(1)
  }

  // Never leave raw prod data in the checkout: a plaintext dump found here is deleted.
  for (const f of ['db/prod.dump', 'db/prod.dump.list']) rmSync(resolve(ROOT, f), { force: true })

  const encrypted = localDump ? readFileSync(localDump) : await downloadNewestDump()

  const dbUrl = libpqUrl(resolveDbUrl())
  logger.info('Decrypting...')
  const dump = await decryptDump(encrypted, identity)

  try {
    logger.info(`Restoring into ${new URL(dbUrl).pathname.slice(1)}...`)
    await restoreDump(dump, dbUrl)
    logger.info('Applying migrations...')
    execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
      stdio: 'inherit',
      env: { ...process.env, CHECKPOINT_DISABLE: '1' },
    })
    logger.info('Anonymising and seeding dev accounts...')
    await anonymiseDatabase(dbUrl)
  } catch (err) {
    await emptyDatabase(dbUrl)
    throw err
  }

  logger.info('Done.')
  logger.info('  volunteer@example.com  / password1')
  logger.info('  admin@example.com      / password1')
  logger.info('  superadmin@example.com / password1')
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    logger.error(err instanceof Error ? err.message : err)
    process.exit(1)
  })
}
