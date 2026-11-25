import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { SCRATCH_TEST_TIMEOUT_MS, withScratchDb } from '@/test/pg'
import { isDisposable } from './disposable-db'
import { restoreStandby, withTls } from './restore-standby'

/** A `pg_dump --format=custom` of a stand-in production database with one volunteer. */
async function productionDump(): Promise<Uint8Array> {
  return withScratchDb(async (db, url) => {
    await db.query('CREATE TABLE volunteers (id int PRIMARY KEY, name text)')
    await db.query("INSERT INTO volunteers VALUES (1, 'Ada')")
    return new Uint8Array(execFileSync('pg_dump', ['--format=custom', '--no-owner', url]))
  })
}

/** What the web service's first start leaves: Action Hub's tables, with no people in them. */
async function migrateEmpty(db: { query: (sql: string) => Promise<unknown> }): Promise<void> {
  await db.query('CREATE TABLE _prisma_migrations (id text)')
  await db.query('CREATE TABLE volunteers (id int PRIMARY KEY, name text)')
  await db.query("CREATE TABLE skills (name text); INSERT INTO skills VALUES ('Writing')")
}

const tables = async (db: { query: (sql: string) => Promise<{ rows: { name: string }[] }> }) =>
  (
    await db.query("SELECT tablename AS name FROM pg_tables WHERE schemaname = 'public' ORDER BY 1")
  ).rows.map((r) => r.name)

describe('restoreStandby', () => {
  it(
    'replaces a freshly migrated database with the dump, unchanged and not marked disposable',
    async () => {
      const dump = await productionDump()
      await withScratchDb(async (db, url) => {
        await migrateEmpty(db)

        await restoreStandby(dump, url)

        expect(await tables(db)).toEqual(['volunteers'])
        const { rows } = await db.query('SELECT id, name FROM volunteers')
        expect(rows).toEqual([{ id: 1, name: 'Ada' }])
        expect(await isDisposable(db)).toBe(false)
      })
    },
    SCRATCH_TEST_TIMEOUT_MS,
  )

  it(
    'restores into a database that was never migrated',
    async () => {
      const dump = await productionDump()
      await withScratchDb(async (db, url) => {
        await restoreStandby(dump, url)
        expect(await tables(db)).toEqual(['volunteers'])
      })
    },
    SCRATCH_TEST_TIMEOUT_MS,
  )

  it(
    'refuses a database that holds any volunteer, and leaves it as it was',
    async () => {
      const dump = await productionDump()
      await withScratchDb(async (db, url) => {
        await migrateEmpty(db)
        await db.query("INSERT INTO volunteers VALUES (7, 'Grace')")

        await expect(restoreStandby(dump, url)).rejects.toThrow(
          /Refusing to restore: database "vitest_scratch_\w+" already holds 1 volunteer\(s\)/,
        )
        const { rows } = await db.query('SELECT id, name FROM volunteers')
        expect(rows).toEqual([{ id: 7, name: 'Grace' }])
      })
    },
    SCRATCH_TEST_TIMEOUT_MS,
  )

  it(
    "refuses another app's database, leaving its tables alone",
    async () => {
      const dump = await productionDump()
      await withScratchDb(async (db, url) => {
        await db.query('CREATE TABLE invoices (id int); INSERT INTO invoices VALUES (1)')

        await expect(restoreStandby(dump, url)).rejects.toThrow(
          /Refusing to restore: database "vitest_scratch_\w+" holds 1 table\(s\) and is not Action Hub's/,
        )
        expect(await tables(db)).toEqual(['invoices'])
      })
    },
    SCRATCH_TEST_TIMEOUT_MS,
  )

  it(
    'empties the schema again when the restore fails, so the next attempt is not refused',
    async () => {
      await withScratchDb(async (db, url) => {
        await migrateEmpty(db)

        await expect(restoreStandby(new TextEncoder().encode('not a dump'), url)).rejects.toThrow(
          /pg_restore exited with 1/,
        )
        expect(await tables(db)).toEqual([])
      })
    },
    SCRATCH_TEST_TIMEOUT_MS,
  )
})

describe('withTls', () => {
  it('requires TLS unless the URL already says how to connect', () => {
    expect(withTls('postgresql://u:p@dpg-x.frankfurt-postgres.render.com/actionhub')).toBe(
      'postgresql://u:p@dpg-x.frankfurt-postgres.render.com/actionhub?sslmode=require',
    )
    expect(withTls('postgresql://u:p@host/db?sslmode=verify-full')).toBe(
      'postgresql://u:p@host/db?sslmode=verify-full',
    )
  })
})
