import { describe, it, expect, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import { dropRun, runPrefix, sweepDeadRuns, withClient } from './pg'

/** The pid of a process that has already exited, so no run can still be using it. */
function deadPid(): number {
  const { pid } = spawnSync('true')
  if (pid === undefined) throw new Error('could not start a process')
  return pid
}

async function createSchema(name: string): Promise<void> {
  await withClient((client) => client.query(`CREATE SCHEMA "${name}"`))
}

async function createDatabase(name: string): Promise<void> {
  await withClient((client) => client.query(`CREATE DATABASE "${name}"`))
}

async function schemaExists(name: string): Promise<boolean> {
  const { rowCount } = await withClient((client) =>
    client.query(`SELECT 1 FROM pg_namespace WHERE nspname = $1`, [name]),
  )
  return rowCount === 1
}

async function databaseExists(name: string): Promise<boolean> {
  const { rowCount } = await withClient((client) =>
    client.query(`SELECT 1 FROM pg_database WHERE datname = $1`, [name]),
  )
  return rowCount === 1
}

describe('test database runs', () => {
  const made: string[] = []
  afterEach(async () => {
    await withClient(async (client) => {
      for (const name of made.splice(0)) {
        await client.query(`DROP SCHEMA IF EXISTS "${name}" CASCADE`)
        await client.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`)
      }
    })
  })

  it("leaves a live run's copies alone when sweeping", async () => {
    const schema = `${runPrefix(process.pid)}live`
    made.push(schema)
    await createSchema(schema)

    await sweepDeadRuns()

    expect(await schemaExists(schema)).toBe(true)
  })

  it("drops a dead run's schemas and databases when sweeping", async () => {
    const prefix = runPrefix(deadPid())
    made.push(`${prefix}schema`, `${prefix}db`)
    await createSchema(`${prefix}schema`)
    await createDatabase(`${prefix}db`)

    await sweepDeadRuns()

    expect(await schemaExists(`${prefix}schema`)).toBe(false)
    expect(await databaseExists(`${prefix}db`)).toBe(false)
  })

  it('leaves names from before runs were prefixed alone', async () => {
    const legacy = `vitest_${process.pid}_legacy`
    made.push(legacy)
    await createSchema(legacy)

    await sweepDeadRuns()

    expect(await schemaExists(legacy)).toBe(true)
  })

  it("drops only its own run's copies at the end of a run", async () => {
    const ownPid = deadPid()
    const own = runPrefix(ownPid)
    const other = runPrefix(deadPid())
    made.push(`${own}copy`, `${other}copy`)
    await createSchema(`${own}copy`)
    await createSchema(`${other}copy`)

    await dropRun(ownPid)

    expect(await schemaExists(`${own}copy`)).toBe(false)
    expect(await schemaExists(`${other}copy`)).toBe(true)
  })
})
