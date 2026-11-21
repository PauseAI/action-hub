/**
 * Before a production deploy applies migrations, a `pg_dump` of the database to the web
 * service's volume, so a migration that goes wrong can be undone to the minute rather than to the
 * last nightly backup. The dumps stay on the volume, readable only by the container's user, and
 * are kept a week: offsite copies are the backup-image service's job (scripts/prod-backup.ts).
 * They are plain `pg_dump --format=custom` files, restored with `pg_restore` directly.
 */

import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
} from 'node:fs'
import { join } from 'node:path'
import { Client } from 'pg'
import { logger } from '../lib/logger'

const RETENTION_MS = 7 * 24 * 60 * 60 * 1000
/** pg_dump gives up after this, so a hung dump cannot hold the deploy. */
const DUMP_TIMEOUT_MS = 5 * 60 * 1000

/** Where the dumps go: `backups/` on the mounted volume, or nowhere without one. */
export function backupDir(
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  const mount = env.RAILWAY_VOLUME_MOUNT_PATH
  return mount ? join(mount, 'backups') : undefined
}

/**
 * The migrations in `migrationsDir` that the database has not applied. An empty database (no
 * `_prisma_migrations` table) has nothing worth a backup, so it counts as none pending.
 */
export async function pendingMigrations(dbUrl: string, migrationsDir: string): Promise<string[]> {
  const client = new Client({ connectionString: dbUrl, connectionTimeoutMillis: 10_000 })
  await client.connect()
  try {
    // Two statements: a single one naming a missing table fails at parse time.
    const table = await client.query("SELECT to_regclass('_prisma_migrations') AS t")
    if (table.rows[0].t === null) return []
    const { rows } = await client.query<{ name: string }>(
      'SELECT migration_name AS name FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL',
    )
    const applied = new Set(rows.map((r) => r.name))
    return readdirSync(migrationsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && existsSync(join(migrationsDir, e.name, 'migration.sql')))
      .map((e) => e.name)
      .filter((name) => !applied.has(name))
  } finally {
    await client.end()
  }
}

/** Deletes the dumps in `dir` older than a week; returns their names. */
export function pruneDumps(dir: string, now: number = Date.now()): string[] {
  if (!existsSync(dir)) return []
  const removed: string[] = []
  for (const f of readdirSync(dir)) {
    const path = join(dir, f)
    if (/\.(dump|db|partial)$/.test(f) && statSync(path).mtimeMs < now - RETENTION_MS) {
      unlinkSync(path)
      removed.push(f)
    }
  }
  return removed
}

/**
 * Dumps the database at `dbUrl` (a libpq URL) into `dir`; returns the file's path. The dump is
 * written under a `.partial` name and renamed once complete, so a failed one never looks whole.
 */
export function createDump(dbUrl: string, dir: string, now: Date = new Date()): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const stamp = now.toISOString().slice(0, 19).replace('T', '_').replace(/:/g, '')
  const dest = join(dir, `actionhub-predeploy-${stamp}.dump`)
  const partial = `${dest}.partial`
  try {
    execFileSync(
      'pg_dump',
      [
        '--format=custom',
        '--no-owner',
        '--no-privileges',
        '--lock-wait-timeout=60s',
        '--file',
        partial,
        dbUrl,
      ],
      { stdio: ['ignore', 'inherit', 'inherit'], timeout: DUMP_TIMEOUT_MS },
    )
    chmodSync(partial, 0o600)
    renameSync(partial, dest)
  } catch (err) {
    rmSync(partial, { force: true })
    throw err
  }
  return dest
}

/**
 * The whole pre-deploy step: only when migrations are pending, since a deploy that applies none
 * changes nothing a dump would protect. Any failure is logged and the deploy goes on.
 */
export async function runPreDeployBackup(dbUrl: string, migrationsDir: string): Promise<void> {
  const dir = backupDir()
  if (!dir) {
    logger.warn('[MIGRATE] No volume mounted: skipping the pre-deploy backup')
    return
  }
  try {
    const pending = await pendingMigrations(dbUrl, migrationsDir)
    if (!pending.length) return
    // Pruned first, so a volume that has filled up frees space for this dump.
    const removed = pruneDumps(dir)
    if (removed.length) logger.info(`[MIGRATE] Removed ${removed.length} dump(s) older than a week`)
    const dest = createDump(dbUrl, dir)
    const kb = (statSync(dest).size / 1024).toFixed(0)
    logger.info(
      `[MIGRATE] Pre-deploy backup before ${pending.length} migration(s): ${dest} (${kb} KB)`,
    )
  } catch (err) {
    logger.error(err, '[MIGRATE] Pre-deploy backup failed (continuing):')
  }
}
