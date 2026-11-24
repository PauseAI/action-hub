import type { TestProject } from 'vitest/node'
import { dropRun, prepareTestDb } from './pg'

declare module 'vitest' {
  export interface ProvidedContext {
    /** The pid of the vitest process, which names every database and schema this run makes. */
    testRunPid: number
  }
}

/** Runs once per `vitest` invocation; see `prepareTestDb`. */
export default async function globalSetup(project: TestProject) {
  await prepareTestDb(process.pid)
  project.provide('testRunPid', process.pid)
  return async () => {
    await dropRun(process.pid)
  }
}
