import { describe, it, expect } from 'vitest'
import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)
const root = fileURLToPath(new URL('.', import.meta.url))

/** The installed version of `pkg` compared with `min`: negative if older, 0 if equal, positive if newer. */
function compareInstalled(pkg: string, min: string): number {
  const { version } = JSON.parse(readFileSync(`${root}node_modules/${pkg}/package.json`, 'utf8'))
  const [a, b] = [version, min].map((v: string) => v.split('.').map(Number))
  return a.map((n, i) => n - b[i]).find((d) => d !== 0) ?? 0
}

// The Prisma CLI reads this config through `@prisma/config` (effect decodes it, deepmerge-ts
// merges its layers) before every generate, migrate and seed, so a broken load stops the build
// and the deploy.
describe('prisma.config.ts', () => {
  it('loads through the Prisma CLI and points it at the schema', async () => {
    const { stdout, stderr } = await run(`${root}node_modules/.bin/prisma`, ['validate'], {
      cwd: root,
      // validate never connects, but the config refuses to load without a URL.
      env: {
        ...process.env,
        CHECKPOINT_DISABLE: '1',
        DATABASE_URL: 'postgresql://localhost/unused',
      },
    })

    expect(`${stdout}${stderr}`).toMatch(/Loaded Prisma config from .*prisma\.config\.ts/)
    expect(`${stdout}${stderr}`).toMatch(/The schema at prisma[/\\]schema\.prisma is valid/)
  }, 60_000)

  // Prisma 6 pins vulnerable versions of both; `overrides` in package.json replaces them.
  it('is loaded with effect and deepmerge-ts versions past their advisories', () => {
    expect(compareInstalled('effect', '3.22.1')).toBeGreaterThanOrEqual(0) // GHSA-7589-6fvf-x4pw
    expect(compareInstalled('deepmerge-ts', '8.0.0')).toBeGreaterThanOrEqual(0) // GHSA-ggr8-5vv4-36mx
  })
})
