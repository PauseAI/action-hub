/**
 * Runs the unit tier with coverage. When the run fails only because coverage fell short, it
 * then lists the uncovered lines, so the gaps are in the same output as the failure. A failing
 * test is already described in full by vitest, and its coverage is incomplete, so no list follows.
 *
 * The run writes into its own directory (see `scripts/unit-runs.ts`) and publishes its coverage
 * to `coverage/` at the end, pass or fail, so CI's summary step and `coverage:report` read it.
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { currentReport } from './coverage-report'
import { publishCoverage, runDir, sweepDeadRunDirs } from './unit-runs'
import { logger } from '../lib/logger'

const RUNS_ROOT = path.resolve('tmp', 'unit-runs')
const RUN_DIR = runDir(RUNS_ROOT, process.pid)
const RESULTS_FILE = path.join(RUN_DIR, 'unit-results.json')
const OWN_COVERAGE = path.join(RUN_DIR, 'coverage')

/** Extra arguments select tests, and a partial run cannot reach full coverage. */
const args = process.argv.slice(2)

sweepDeadRunDirs(RUNS_ROOT)
fs.rmSync(RUN_DIR, { recursive: true, force: true })
const { status } = spawnSync('npx', ['vitest', 'run', '--coverage', ...args], {
  stdio: 'inherit',
  env: { ...process.env, UNIT_RUN_DIR: RUN_DIR },
})

if (status !== 0 && args.length === 0 && fs.existsSync(RESULTS_FILE)) {
  const results = JSON.parse(fs.readFileSync(RESULTS_FILE, 'utf8')) as {
    numFailedTests: number
    numFailedTestSuites: number
  }
  if (results.numFailedTests === 0 && results.numFailedTestSuites === 0) {
    logger.info(`\n${currentReport(OWN_COVERAGE)}`)
  }
}

publishCoverage(OWN_COVERAGE, path.resolve('coverage'))
fs.rmSync(RUN_DIR, { recursive: true, force: true })
process.exit(status ?? 1)
