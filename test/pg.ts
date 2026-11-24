import fs from 'node:fs'
import path from 'node:path'
import { Client } from 'pg'
// Imported for its side effect of loading .env and .env.local, so the variables below can live there.
import '../lib/db-url'
import { markDisposable } from '../scripts/disposable-db'
import { isAlive } from '../scripts/unit-runs'

/**
 * Every test file gets its own private copy of the schema, in one of two ways chosen by
 * `TEST_DB_MODE` (settable in .env.local):
 *
 * - `clone`: global setup migrates one template database and each file clones it with
 *   `CREATE DATABASE ... TEMPLATE`, copying files instead of replaying SQL. Needs CREATEDB.
 * - `schema`: each file creates a schema in the server's database and replays the migration
 *   SQL into it. Needs no privilege beyond the database itself.
 *
 * Cloning pays off only when the server skips fsync, as `db-test` does: with durability on
 * the two take about the same time. So unless `TEST_DB_MODE` says otherwise, a run clones when
 * `TEST_DATABASE_URL` names a dedicated server and replays into schemas when it does not.
 * `TEST_DATABASE_URL` points the suite at a throwaway server (see docker-compose.yml) so it
 * never shares one with development data; without it the suite uses `DATABASE_URL`.
 *
 * These helpers read the server's URL from the environment, never from `lib/db-url`, whose
 * `resolveDbUrl` is pointed at the file's own copy once `setup-db.ts` has run.
 *
 * Every name a run makes starts with `runPrefix` of the pid of the vitest process that runs
 * it, so a run can tell its own copies from those of a run still going in another terminal or
 * worktree against the same server, and drop only what a run that has ended left behind.
 */
export type TestDbMode = 'clone' | 'schema'

const RUN_NAME = /^vitestrun_(\d+)_/
const MIGRATIONS_DIR = path.resolve(__dirname, '..', 'prisma', 'migrations')

/** Postgres refuses a clone while anything, even autovacuum, is connected to the template. */
const OBJECT_IN_USE = '55006'
const CLONE_ATTEMPTS = 20
const DEADLOCK_DETECTED = '40P01'
const DROP_ATTEMPTS = 5

export function runPrefix(runPid: number): string {
  return `vitestrun_${runPid}_`
}

function templateDb(runPid: number): string {
  return `${runPrefix(runPid)}template`
}

/** An explicit `TEST_DB_MODE` wins; otherwise cloning is used only on a dedicated test server. */
export function testDbMode(): TestDbMode {
  const mode = process.env.TEST_DB_MODE
  if (mode === 'clone' || mode === 'schema') return mode
  return process.env.TEST_DATABASE_URL ? 'clone' : 'schema'
}

export function resolveTestDbUrl(): string {
  const url = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL
  if (!url) throw new Error('DATABASE_URL is not set')
  return url
}

export function migrationSql(): string {
  return fs
    .readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort()
    .map((dir) => fs.readFileSync(path.join(MIGRATIONS_DIR, dir, 'migration.sql'), 'utf8'))
    .join('\n')
}

function urlForDatabase(database: string): URL {
  const url = new URL(resolveTestDbUrl())
  url.pathname = `/${database}`
  return url
}

/** The URL Prisma is given for the private copy called `name`. */
export function testUrl(name: string): string {
  let url: URL
  if (testDbMode() === 'clone') {
    url = urlForDatabase(name)
    url.searchParams.set('schema', 'public')
  } else {
    url = new URL(resolveTestDbUrl())
    url.searchParams.set('schema', name)
  }
  // Prisma's default pool is 2 × cores + 1 per client; with a worker per core that overruns
  // Postgres's default max_connections on a large machine. Test files are mostly sequential.
  url.searchParams.set('connection_limit', '3')
  return url.toString()
}

async function connect(connectionString: string): Promise<Client> {
  const client = new Client({ connectionString })
  await client.connect()
  return client
}

/** Runs against the server's own database, from which databases are created and dropped. */
export async function withClient<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const client = await connect(resolveTestDbUrl())
  try {
    return await fn(client)
  } finally {
    await client.end()
  }
}

async function createSchema(schema: string): Promise<void> {
  await withClient(async (client) => {
    await client.query(`CREATE SCHEMA "${schema}"`)
    await client.query(`SET search_path TO "${schema}"`)
    await client.query(migrationSql())
  })
}

async function createTemplate(runPid: number): Promise<void> {
  await withClient((client) => client.query(`CREATE DATABASE "${templateDb(runPid)}"`))
  const client = await connect(urlForDatabase(templateDb(runPid)).toString())
  try {
    await client.query(migrationSql())
  } finally {
    await client.end()
  }
}

async function cloneTemplate(runPid: number, database: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await withClient((client) =>
        client.query(`CREATE DATABASE "${database}" TEMPLATE "${templateDb(runPid)}"`),
      )
      return
    } catch (e) {
      if ((e as { code?: string }).code !== OBJECT_IN_USE || attempt === CLONE_ATTEMPTS) throw e
      await new Promise((resolve) => setTimeout(resolve, 50 * attempt))
    }
  }
}

async function dropSchema(schema: string): Promise<void> {
  // A query the test file left in flight can still hold locks in the schema, and Postgres
  // may pick the drop as the deadlock victim.
  for (let attempt = 1; ; attempt++) {
    try {
      await withClient((client) => client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`))
      return
    } catch (e) {
      if ((e as { code?: string }).code !== DEADLOCK_DETECTED || attempt === DROP_ATTEMPTS) throw e
    }
  }
}

async function dropDatabase(database: string): Promise<void> {
  // FORCE disconnects a query the test file left in flight, which would otherwise block the drop.
  await withClient((client) => client.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`))
}

/**
 * Once per run: clears what ended runs left, including an earlier process with this pid, then
 * prepares the mode. Building the template, or one probe schema, makes a broken migration or
 * an unreachable database fail here with one clear error instead of once per test file. Every
 * copy must be marked disposable for the dev-database scripts to run against it (see
 * scripts/disposable-db.ts).
 */
export async function prepareTestDb(runPid: number): Promise<void> {
  await dropRun(runPid)
  await sweepDeadRuns()
  if (testDbMode() === 'clone') {
    await createTemplate(runPid)
  } else {
    await createSchema(`${runPrefix(runPid)}probe`)
    await withClient(markDisposable)
  }
}

/**
 * Gives a test file its private copy, named `name`. A clone is marked disposable here, since
 * it does not inherit the template's database settings; schema copies share the server's
 * database, which `prepareTestDb` marks.
 */
export async function createTestDb(runPid: number, name: string): Promise<void> {
  if (testDbMode() === 'clone') {
    await cloneTemplate(runPid, name)
    const client = await connect(urlForDatabase(name).toString())
    try {
      await markDisposable(client)
    } finally {
      await client.end()
    }
  } else {
    await createSchema(name)
  }
}

export async function dropTestDb(name: string): Promise<void> {
  if (testDbMode() === 'clone') await dropDatabase(name)
  else await dropSchema(name)
}

/** Drops every database and schema of the runs `doomed` picks, whichever mode made them. */
async function dropRuns(doomed: (runPid: number) => boolean): Promise<void> {
  await withClient(async (client) => {
    const pick = (name: string) => {
      const match = RUN_NAME.exec(name)
      return match !== null && doomed(Number(match[1]))
    }
    const databases = await client.query<{ datname: string }>(`SELECT datname FROM pg_database`)
    for (const { datname } of databases.rows.filter((r) => pick(r.datname))) {
      await client.query(`DROP DATABASE IF EXISTS "${datname}" WITH (FORCE)`)
    }
    const schemas = await client.query<{ nspname: string }>(`SELECT nspname FROM pg_namespace`)
    for (const { nspname } of schemas.rows.filter((r) => pick(r.nspname))) {
      await client.query(`DROP SCHEMA IF EXISTS "${nspname}" CASCADE`)
    }
  })
}

/** Drops the template and every copy of the run `runPid`, left in place by every other run. */
export async function dropRun(runPid: number): Promise<void> {
  await dropRuns((pid) => pid === runPid)
}

/**
 * Drops what runs whose vitest process has ended left behind. A run still going in another
 * terminal or worktree keeps its copies. Names without a run's prefix are never touched.
 */
export async function sweepDeadRuns(): Promise<void> {
  await dropRuns((pid) => !isAlive(pid))
}
