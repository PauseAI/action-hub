import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { publishCoverage, runDir, sweepDeadRunDirs } from './unit-runs'

function deadPid(): number {
  const { pid } = spawnSync('true')
  if (pid === undefined) throw new Error('could not start a process')
  return pid
}

describe('unit run directories', () => {
  let root: string
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'unit-runs-'))
  })
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true })
  })

  it('sweeps the directories of ended runs and keeps live ones', () => {
    const live = runDir(root, process.pid)
    const dead = runDir(root, deadPid())
    fs.mkdirSync(live, { recursive: true })
    fs.mkdirSync(dead, { recursive: true })

    sweepDeadRunDirs(root)

    expect(fs.existsSync(live)).toBe(true)
    expect(fs.existsSync(dead)).toBe(false)
  })

  it('sweeps nothing when no run has made a directory yet', () => {
    expect(() => sweepDeadRunDirs(path.join(root, 'missing'))).not.toThrow()
  })

  it("replaces the published coverage with a run's own", () => {
    const target = path.join(root, 'coverage')
    fs.mkdirSync(target)
    fs.writeFileSync(path.join(target, 'old.json'), '{}')
    const own = path.join(runDir(root, process.pid), 'coverage')
    fs.mkdirSync(own, { recursive: true })
    fs.writeFileSync(path.join(own, 'coverage-summary.json'), '{}')

    publishCoverage(own, target)

    expect(fs.readdirSync(target)).toEqual(['coverage-summary.json'])
    expect(fs.existsSync(own)).toBe(false)
  })

  it('leaves the published coverage alone when a run produced none', () => {
    const target = path.join(root, 'coverage')
    fs.mkdirSync(target)
    fs.writeFileSync(path.join(target, 'old.json'), '{}')

    publishCoverage(path.join(runDir(root, process.pid), 'coverage'), target)

    expect(fs.readdirSync(target)).toEqual(['old.json'])
  })
})
