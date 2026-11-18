#!/usr/bin/env node
/**
 * Restores the latest prod backup (scripts/prod-backup.ts) into the database at DATABASE_URL,
 * migrates it to this checkout's schema (the scrub names every current column, and the backup can
 * predate the newest migrations), then anonymises it and seeds the dev accounts
 * (scripts/anonymise-db.ts). If the migration or the scrub fails the database is emptied again,
 * so raw prod data never outlives it. Refuses to touch the production environment.
 *
 * Needs BACKUP_AGE_IDENTITY_FILE, and to download, BACKUP_B2_READ_KEY_ID and
 * BACKUP_B2_READ_SECRET (BACKUP_B2_BUCKET optional), from the environment or the env file.
 *
 * Usage:
 *   npx tsx scripts/fetch-prod-db.ts                       # reads variables from .env.backup
 *   npx tsx scripts/fetch-prod-db.ts --env /path/to/env
 *   npx tsx scripts/fetch-prod-db.ts --file actionhub-<time>.dump.age   # a dump already downloaded
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync, spawnSync } from 'node:child_process'
import { Client } from 'pg'
import { libpqUrl, resolveDbUrl } from '../lib/db-url'
import { logger } from '../lib/logger'
import { anonymise } from './anonymise-db'
import { seedDevAccounts } from './seed-dev-accounts'
import { claimDisposable } from './disposable-db'
import {
  B2Reader,
  DEFAULT_BUCKET,
  STALE_AFTER_MS,
  decryptDump,
  dumpTakenAt,
  newestDump,
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

// ── Env loading ───────────────────────────────────────────────────────────────

function loadEnvFile(path: string): void {
  if (!existsSync(path)) return
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue
    const eqIdx = trimmed.indexOf('=')
    const key = trimmed.slice(0, eqIdx).trim()
    const value = trimmed
      .slice(eqIdx + 1)
      .trim()
      .replace(/^['"]|['"]$/g, '')
    if (!(key in process.env)) process.env[key] = value
  }
}

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

/**
 * Empties the public schema and restores the dump into it, feeding pg_restore from memory so the
 * plaintext never touches disk. The dump's own `CREATE SCHEMA public` entry is filtered out of
 * the restore list, since the schema is recreated here first; `pg_restore -l`/`-L` is the
 * documented way to skip entries. A dump piped out of pg_dump has no data offsets, so
 * pg_restore reads it in order, which the filtered list keeps.
 */
export async function restoreDump(dump: Uint8Array, dbUrl: string): Promise<void> {
  await emptyDatabase(dbUrl)
  const filtered = pgRestore(['-l'], dump)
    .split('\n')
    .filter((line) => !/ SCHEMA - public /.test(line))
    .join('\n')
  const dir = mkdtempSync(join(tmpdir(), 'fetch-prod-db-'))
  try {
    const listPath = join(dir, 'restore.list')
    writeFileSync(listPath, filtered)
    pgRestore(['--no-owner', '--no-privileges', '--use-list', listPath, '--dbname', dbUrl], dump)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/**
 * Runs pg_restore with the dump on stdin and returns its output. `-l` exits once it has read the
 * table of contents, so a broken pipe is expected; the exit status decides success.
 */
function pgRestore(args: string[], dump: Uint8Array): string {
  const r = spawnSync('pg_restore', args, {
    input: dump,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['pipe', 'pipe', 'inherit'],
  })
  if (r.error && (r.error as NodeJS.ErrnoException).code !== 'EPIPE') throw r.error
  if (r.status !== 0) throw new Error(`pg_restore exited with ${r.status ?? r.signal}`)
  return r.stdout
}

// ── Download ──────────────────────────────────────────────────────────────────

async function downloadNewest(): Promise<Uint8Array> {
  const keyId = process.env.BACKUP_B2_READ_KEY_ID
  const secret = process.env.BACKUP_B2_READ_SECRET
  if (!keyId || !secret) {
    logger.error(
      `BACKUP_B2_READ_KEY_ID and BACKUP_B2_READ_SECRET must hold the bucket's read-only key (Psono: "actionhub-backup-read"). Add them to '${envFile}' or export them, or pass --file with a dump you downloaded.`,
    )
    process.exit(1)
  }
  const b2 = new B2Reader(keyId, secret, process.env.BACKUP_B2_BUCKET || DEFAULT_BUCKET)

  logger.info(`Listing backups in ${b2.bucket}...`)
  const latest = newestDump(await b2.listDumps())
  if (!latest) {
    logger.error(`No backups/actionhub-*.dump.age files in ${b2.bucket}.`)
    process.exit(1)
  }
  logger.info(`Latest backup: ${latest.fileName} (${(latest.contentLength / 1024).toFixed(0)} KB)`)
  const age = Date.now() - dumpTakenAt(latest.fileName).getTime()
  if (age > STALE_AFTER_MS) {
    logger.warn(
      `This dump is ${Math.floor(age / 86_400_000)} days old: recent nightly backups may have failed.`,
    )
  }

  logger.info('Downloading...')
  return b2.download(latest)
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

  const identityFile = process.env.BACKUP_AGE_IDENTITY_FILE
  if (!identityFile) {
    logger.error(
      `BACKUP_AGE_IDENTITY_FILE must name a file holding Action Hub's age identity (Psono: "Action Hub - Object Storage (R2, B2, S3) Backup Encryption Key"). Add it to '${envFile}' or export it.`,
    )
    process.exit(1)
  }

  const encrypted = localDump ? readFileSync(localDump) : await downloadNewest()

  const dbUrl = libpqUrl(resolveDbUrl())
  logger.info('Decrypting...')
  const dump = await decryptDump(encrypted, identityFile)

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
