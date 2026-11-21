import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from 'pg'
import { libpqUrl, resolveDbUrl } from '@/lib/db-url'
import { backupDir, createDump, pendingMigrations, pruneDumps } from './pre-deploy-backup'

/** A libpq URL for this test file's database, with its schema (if it has one) on the search path. */
function fileDbUrl(schema = new URL(resolveDbUrl()).searchParams.get('schema')): string {
  const url = new URL(libpqUrl(resolveDbUrl()))
  if (schema) url.searchParams.set('options', `-c search_path=${schema}`)
  return url.toString()
}

describe('backupDir', () => {
  it('is backups/ on the mounted volume, and nothing without one', () => {
    expect(backupDir({ RAILWAY_VOLUME_MOUNT_PATH: '/data' })).toBe('/data/backups')
    expect(backupDir({})).toBeUndefined()
  })
})

describe('pruneDumps', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'predeploy-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('deletes dumps older than a week and leaves newer ones and other files', () => {
    const now = new Date('2026-11-21T12:00:00Z').getTime()
    const at = (name: string, daysAgo: number) => {
      writeFileSync(join(dir, name), 'x')
      const t = (now - daysAgo * 86_400_000) / 1000
      utimesSync(join(dir, name), t, t)
    }
    at('actionhub-predeploy-2026-11-10_120000.dump', 11)
    at('catalyse-2026-11-13_080000.dump', 8)
    at('actionhub-predeploy-2026-11-20_120000.dump', 1)
    at('catalyse-2026-11-01_080000.db', 20)
    at('actionhub-predeploy-2026-11-09_120000.dump.partial', 12)
    at('notes.txt', 30)
    expect(pruneDumps(dir, now).sort()).toEqual([
      'actionhub-predeploy-2026-11-09_120000.dump.partial',
      'actionhub-predeploy-2026-11-10_120000.dump',
      'catalyse-2026-11-01_080000.db',
      'catalyse-2026-11-13_080000.dump',
    ])
    expect(readdirSync(dir).sort()).toEqual([
      'actionhub-predeploy-2026-11-20_120000.dump',
      'notes.txt',
    ])
  })

  it('does nothing when the directory does not exist yet', () => {
    expect(pruneDumps(join(dir, 'missing'))).toEqual([])
    expect(existsSync(join(dir, 'missing'))).toBe(false)
  })
})

describe('pendingMigrations', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'migrations-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const migration = (name: string, sql = true) => {
    mkdirSync(join(dir, name))
    if (sql) writeFileSync(join(dir, name, 'migration.sql'), '-- sql')
  }

  it('lists the migrations the database has not applied, or rolled back, or never finished', async () => {
    const schema = `predeploy_${process.pid}`
    const db = new Client({ connectionString: fileDbUrl() })
    await db.connect()
    try {
      await db.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE; CREATE SCHEMA ${schema}`)
      await db.query(
        `CREATE TABLE ${schema}._prisma_migrations
           (migration_name text, finished_at timestamptz, rolled_back_at timestamptz)`,
      )
      await db.query(
        `INSERT INTO ${schema}._prisma_migrations VALUES
           ('1_applied', now(), NULL), ('2_rolled_back', now(), now()), ('3_failed', NULL, NULL)`,
      )
      for (const name of ['1_applied', '2_rolled_back', '3_failed', '4_new']) migration(name)
      migration('5_no_sql_file', false)
      expect((await pendingMigrations(fileDbUrl(schema), dir)).sort()).toEqual([
        '2_rolled_back',
        '3_failed',
        '4_new',
      ])
    } finally {
      await db.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
      await db.end()
    }
  })

  it('finds none pending in a database with no migrations table', async () => {
    migration('29991231000000_not_yet')
    expect(await pendingMigrations(fileDbUrl('no_such_schema'), dir)).toEqual([])
  })
})

describe('createDump', () => {
  it('leaves no partial file behind when pg_dump fails', () => {
    const dir = mkdtempSync(join(tmpdir(), 'predeploy-'))
    try {
      expect(() => createDump('postgresql://nobody@127.0.0.1:1/none', dir)).toThrow()
      expect(readdirSync(dir)).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
