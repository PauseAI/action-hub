import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { backupDir, pruneDumps } from './pre-deploy-backup'

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
    at('notes.txt', 30)
    expect(pruneDumps(dir, now).sort()).toEqual([
      'actionhub-predeploy-2026-11-10_120000.dump',
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
