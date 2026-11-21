/**
 * Before each production migration, a `pg_dump` of the database to the web service's volume, so
 * a migration that goes wrong can be undone to the minute rather than to the last nightly backup.
 * The dumps stay on the volume, readable only by the container's user, and are kept a week:
 * offsite copies are the backup-image service's job (scripts/prod-backup.ts).
 */

import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { Client } from 'pg'
import { logger } from '../lib/logger'

const RETENTION_MS = 7 * 24 * 60 * 60 * 1000

/** Where the dumps go: `backups/` on the mounted volume, or nowhere without one. */
export function backupDir(
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  const mount = env.RAILWAY_VOLUME_MOUNT_PATH
  return mount ? join(mount, 'backups') : undefined
}

/** An unmigrated or not-yet-loaded database has nothing worth a backup. */
export async function hasVolunteers(dbUrl: string): Promise<boolean> {
  const client = new Client({ connectionString: dbUrl })
  await client.connect()
  try {
    // Two statements: a single one naming a missing table fails at parse time.
    const table = await client.query("SELECT to_regclass('public.volunteers') AS t")
    if (table.rows[0].t === null) return false
    const { rows } = await client.query<{ present: boolean }>(
      'SELECT EXISTS (SELECT 1 FROM volunteers) AS present',
    )
    return rows[0].present
  } finally {
    await client.end()
  }
}

/** Throws when `pg_dump` is older than the server, which it refuses to dump. */
async function checkClientVersion(dbUrl: string): Promise<void> {
  const client = Number(
    /\d+/.exec(execFileSync('pg_dump', ['--version'], { encoding: 'utf8' }))?.[0],
  )
  const db = new Client({ connectionString: dbUrl })
  await db.connect()
  try {
    const { rows } = await db.query<{ v: string }>('SHOW server_version')
    const server = Number(/\d+/.exec(rows[0].v)?.[0])
    if (client < server) {
      throw new Error(
        `pg_dump ${client} cannot back up a PostgreSQL ${server} server — bump postgresql-client-${server} in the Dockerfile`,
      )
    }
  } finally {
    await db.end()
  }
}

/** Deletes the dumps in `dir` older than a week; returns their names. */
export function pruneDumps(dir: string, now: number = Date.now()): string[] {
  if (!existsSync(dir)) return []
  const removed: string[] = []
  for (const f of readdirSync(dir)) {
    const path = join(dir, f)
    if (f.endsWith('.dump') && statSync(path).mtimeMs < now - RETENTION_MS) {
      unlinkSync(path)
      removed.push(f)
    }
  }
  return removed
}

/** Dumps the database at `dbUrl` (a libpq URL) into `dir`; returns the file's path. */
export function createDump(dbUrl: string, dir: string, now: Date = new Date()): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const stamp = now.toISOString().slice(0, 19).replace('T', '_').replace(/:/g, '')
  const dest = join(dir, `actionhub-predeploy-${stamp}.dump`)
  // The same format as the nightly backups, so one restore procedure serves both.
  execFileSync(
    'pg_dump',
    ['--format=custom', '--no-owner', '--no-privileges', '--file', dest, dbUrl],
    { stdio: ['ignore', 'inherit', 'inherit'] },
  )
  chmodSync(dest, 0o600)
  return dest
}

/** The whole pre-deploy step; any failure is logged and the deploy goes on. */
export async function runPreDeployBackup(dbUrl: string): Promise<void> {
  const dir = backupDir()
  if (!dir) {
    logger.warn('[MIGRATE] No volume mounted: skipping the pre-deploy backup')
    return
  }
  try {
    if (!(await hasVolunteers(dbUrl))) return
    await checkClientVersion(dbUrl)
    const dest = createDump(dbUrl, dir)
    logger.info(
      `[MIGRATE] Pre-deploy backup: ${dest} (${(statSync(dest).size / 1024).toFixed(0)} KB)`,
    )
    const removed = pruneDumps(dir)
    if (removed.length) logger.info(`[MIGRATE] Removed ${removed.length} dump(s) older than a week`)
  } catch (err) {
    logger.error(err, '[MIGRATE] Pre-deploy backup failed (continuing):')
  }
}
