import { describe, it, expect } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)

// The Prisma CLI reads this config through `@prisma/config` (effect decodes it, deepmerge-ts
// merges its layers) before every generate, migrate and seed, so a broken load stops the build
// and the deploy.
describe('prisma.config.ts', () => {
  it('loads through the Prisma CLI and points it at the schema', async () => {
    const { stdout, stderr } = await run('node_modules/.bin/prisma', ['validate'], {
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
})
