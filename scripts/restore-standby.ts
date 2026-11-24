#!/usr/bin/env node
/**
 * Restores the newest production backup, unchanged, into the standby database on Render: the
 * failover counterpart of fetch-prod-db, which anonymises. docs/standby-render.md is the runbook.
 * It refuses any database but a new standby's, so it can never overwrite one in use,
 * production, or another app's. Migrations newer than the dump are left to the web
 * service, which applies them when it starts.
 *
 * Reads, only from the env file: RESTORE_DATABASE_URL, the standby's external
 * connection URL (its own name, so a DATABASE_URL in .env.local can never be the target); an age
 * identity (BACKUP_AGE_IDENTITY_FILE, or BACKUP_AGE_IDENTITY); and to download,
 * BACKUP_B2_READ_KEY_ID and BACKUP_B2_READ_SECRET.
 *
 * Usage:
 *   npm run restore-standby -- --env ~/standby.env
 *   npm run restore-standby -- --env ~/standby.env --file actionhub-<time>.dump.age
 */

import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Client } from 'pg'
import { libpqUrl, loadEnvFile } from '../lib/db-url'
import { logger } from '../lib/logger'
import {
  decryptDump,
  downloadNewestDump,
  emptyPublicSchema,
  readAgeIdentity,
  restoreIntoEmptySchema,
} from './prod-backup'

/**
 * Render refuses external connections without TLS, so a URL with no `sslmode` gets `require`:
 * encrypted, without checking the certificate, as psql connects by default.
 */
export function withTls(dbUrl: string): string {
  const url = new URL(dbUrl)
  if (!url.searchParams.has('sslmode')) url.searchParams.set('sslmode', 'require')
  return url.toString()
}

/** The libpq URL for `pg`, which reads `sslmode` as libpq does only when told to. */
function pgUrl(dbUrl: string): string {
  const url = new URL(dbUrl)
  if (url.searchParams.has('sslmode')) url.searchParams.set('uselibpqcompat', 'true')
  return url.toString()
}

const INPUTS = [
  'RESTORE_DATABASE_URL',
  'BACKUP_AGE_IDENTITY',
  'BACKUP_AGE_IDENTITY_FILE',
  'BACKUP_B2_READ_KEY_ID',
  'BACKUP_B2_READ_SECRET',
  'BACKUP_B2_BUCKET',
]

async function withClient<T>(dbUrl: string, fn: (db: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: pgUrl(dbUrl) })
  await client.connect()
  try {
    return await fn(client)
  } finally {
    await client.end()
  }
}

/**
 * Throws unless the database is a new standby: a public schema with no tables, or Action Hub's
 * migrated schema with no volunteers in it, as the web service's first start leaves it. Any
 * other database, Action Hub's or not, is refused before anything is dropped.
 */
async function assertNewStandby(db: Client, name: string): Promise<void> {
  const { rows } = await db.query<{ tables: number; migrated: boolean; people: boolean }>(
    `SELECT count(*)::int AS tables,
            to_regclass('public._prisma_migrations') IS NOT NULL AS migrated,
            to_regclass('public.volunteers') IS NOT NULL AS people
       FROM pg_tables WHERE schemaname = 'public'`,
  )
  const { tables, migrated, people } = rows[0]
  if (tables === 0) return
  if (!migrated || !people) {
    throw new Error(
      `Refusing to restore: database "${name}" holds ${tables} table(s) and is not Action Hub's. Check RESTORE_DATABASE_URL is the standby's.`,
    )
  }
  const count = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM public.volunteers')
  const volunteers = count.rows[0].n
  if (volunteers > 0) {
    throw new Error(
      `Refusing to restore: database "${name}" already holds ${volunteers} volunteer(s). Only a new standby is restored into.`,
    )
  }
}

/**
 * Empties the public schema of the database at `dbUrl` (a libpq URL) and restores the dump into
 * it, refusing first unless it is a new standby (`assertNewStandby`). A failed restore empties the schema again, so the
 * next attempt is not refused over a partial copy; if that fails too, the restore's error is
 * the one thrown.
 */
export async function restoreStandby(dump: Uint8Array, dbUrl: string): Promise<void> {
  await withClient(dbUrl, async (db) => {
    await assertNewStandby(db, new URL(dbUrl).pathname.slice(1))
    await emptyPublicSchema(db)
  })
  try {
    restoreIntoEmptySchema(dump, dbUrl)
  } catch (err) {
    try {
      await withClient(dbUrl, emptyPublicSchema)
    } catch (cleanup) {
      logger.error(
        `Could not empty the standby after the failed restore (${cleanup instanceof Error ? cleanup.message : cleanup}). Empty it by hand before running again (docs/standby-render.md).`,
      )
    }
    throw err
  }
}

async function main(args: string[]): Promise<void> {
  const flag = (name: string) => {
    const i = args.indexOf(name)
    return i === -1 ? undefined : args[i + 1]
  }
  const envFile = flag('--env')
  if (!envFile || !existsSync(envFile)) {
    throw new Error(
      `--env must name the standby's env file${envFile ? `; ${envFile} does not exist` : ''}.`,
    )
  }
  // Only the env file supplies these: lib/db-url has already loaded .env.local, whose backup
  // settings (a preview identity, say) would otherwise win over it.
  for (const key of INPUTS) delete process.env[key]
  loadEnvFile(envFile)
  const localDump = flag('--file')

  const target = process.env.RESTORE_DATABASE_URL
  if (!target) {
    throw new Error(
      "RESTORE_DATABASE_URL must hold the standby database's External Database URL (Render dashboard > the database > Connect).",
    )
  }
  const identity = readAgeIdentity()
  if (!identity) {
    throw new Error(
      `BACKUP_AGE_IDENTITY_FILE must name a file holding Action Hub's age identity (Psono: "Action Hub - Object Storage (R2, B2, S3) Backup Encryption Key"), or BACKUP_AGE_IDENTITY hold it.`,
    )
  }

  const encrypted = localDump ? readFileSync(localDump) : await downloadNewestDump()
  logger.info('Decrypting...')
  const dump = await decryptDump(encrypted, identity)

  const dbUrl = withTls(libpqUrl(target))
  logger.info(`Restoring into ${new URL(dbUrl).host}${new URL(dbUrl).pathname}...`)
  await restoreStandby(dump, dbUrl)
  logger.info('Done. Restart the web service so it applies any newer migrations.')
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((err) => {
    logger.error(err instanceof Error ? err.message : err)
    process.exit(1)
  })
}
