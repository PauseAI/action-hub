import { execSync } from 'child_process'
import { readdirSync, rmdirSync } from 'fs'
import { join } from 'path'
import { libpqUrl, resolveDbUrl } from '../lib/db-url'
import { logger } from '../lib/logger'
import { runPreDeployBackup } from './pre-deploy-backup'

process.env.DATABASE_URL = resolveDbUrl()

function removeEmptyMigrationDirs() {
  const migrationsDir = join(process.cwd(), 'prisma', 'migrations')
  const entries = readdirSync(migrationsDir, { withFileTypes: true })
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const dir = join(migrationsDir, entry.name)
    const files = readdirSync(dir)
    if (!files.includes('migration.sql')) {
      logger.warn(`[MIGRATE] migration dir "${entry.name}" has no migration.sql — removing`)
      rmdirSync(dir)
    }
  }
}

async function main() {
  removeEmptyMigrationDirs()
  if (process.env.RAILWAY_ENVIRONMENT_NAME === 'production') {
    await runPreDeployBackup(libpqUrl(resolveDbUrl()), join(process.cwd(), 'prisma', 'migrations'))
  }
  execSync('npx prisma migrate deploy', { stdio: 'inherit' })
}

main().catch((err) => {
  logger.error(err, '[MIGRATE] Fatal error:')
  process.exit(1)
})
