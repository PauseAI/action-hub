import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { withScratchDb } from '@/test/pg'
import { isDisposable } from './disposable-db'
import { restoreStandby, withTls } from './restore-standby'

// Creating a database can outlast the default timeout while the rest of the suite keeps the
// same server busy.
const SCRATCH_TEST_TIMEOUT_MS = 60_000

/** A `pg_dump --format=custom` of a stand-in production database with one volunteer. */
async function productionDump(): Promise<Uint8Array> {
  return withScratchDb(async (db, url) => {
    await db.query('CREATE TABLE volunteers (id int PRIMARY KEY, name text)')
    await db.query("INSERT INTO volunteers VALUES (1, 'Ada')")
    return new Uint8Array(execFileSync('pg_dump', ['--format=custom', '--no-owner', url]))
  })
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
        // What the web service's first start leaves: the schema and reference data, no people.
        await db.query('CREATE TABLE volunteers (id int PRIMARY KEY, name text)')
        await db.query("CREATE TABLE skills (name text); INSERT INTO skills VALUES ('Writing')")

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
        await db.query('CREATE TABLE volunteers (id int PRIMARY KEY, name text)')
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
    'empties the schema again when the restore fails, so the next attempt is not refused',
    async () => {
      await withScratchDb(async (db, url) => {
        await db.query('CREATE TABLE volunteers (id int PRIMARY KEY, name text)')

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
