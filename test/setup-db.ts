import { afterAll, beforeEach, inject } from 'vitest'
import { createTestDb, dropTestDb, runPrefix, testUrl } from './pg'
import { setDatabaseUrl } from '@/lib/db-url'
import { setEmailTransport } from '@/lib/email-transport'
import { setGoogleVerifier } from '@/lib/google-auth'
import { setRateLimiter } from '@/lib/rate-limit'
import { setSnsGateway } from '@/lib/sns'
import { emails } from './fakes/email'
import { google } from './fakes/google'
import { rateLimit } from './fakes/rate-limit'
import { sns } from './fakes/sns'
import { cronJobs } from './fakes/cron-jobs'
import { GLOBAL_ADMIN_SLOTS, globalAdminEmail } from './admin-emails'

/**
 * Gives the current test file its own private copy of the schema (see `test/pg.ts`). vitest
 * isolates module state per file, so `lib/prisma` is instantiated afresh in each and reads
 * the URL set here at that moment — this runs before any test module is imported.
 */
const DROP_TIMEOUT_MS = 60_000
const runPid = inject('testRunPid')
const name = `${runPrefix(runPid)}${process.pid}_${Math.random().toString(36).slice(2)}`
await createTestDb(runPid, name)
setDatabaseUrl(testUrl(name))
afterAll(async () => {
  // Lets in-flight queries finish and closes the pool, so the drop is not fighting them.
  const { prisma } = await import('@/lib/prisma')
  await prisma.$disconnect()
  await dropTestDb(name)
  // Dropping a database makes Postgres checkpoint, and with every worker dropping at once on a
  // server that syncs to disk that can take longer than the default hook timeout.
}, DROP_TIMEOUT_MS)
// Routers return verification and invite tokens in their responses when email is stubbed.
process.env.STUB_EMAIL = 'true'
process.env.STUB_GOOGLE = 'true'
// A configured client id makes the pages render their Google button; the stub flag above
// keeps the server from verifying real credentials.
process.env.GOOGLE_CLIENT_ID = 'test-google-client'
// Read at module load by Analytics, so it must be set before any import.
process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID = 'G-TEST'
// The addresses createSuperAdmin and createAdmin (test/factories.ts) give their global admins.
process.env.ADMIN_EMAILS = [
  ...Array.from({ length: 20 }, (_, i) => `admin${i || ''}@example.com`),
  ...Array.from({ length: GLOBAL_ADMIN_SLOTS }, (_, i) => globalAdminEmail(i)),
].join(',')
process.env.APP_URL = 'http://localhost:3000'
process.env.CRON_SECRET = 'cron-secret'
process.env.EMAIL_HASH_SECRET = 'email-hash-secret'
// The network edge is faked: outgoing email lands in the in-memory outbox `emails`, Google
// credentials verify only when a test has registered them with `google.accept`, requests
// are rate-limited only when a test asks with `rateLimit.denyNext`, SNS messages are signed
// and checked against `sns`'s own key, and the scheduled jobs
// record that they ran instead of backing up or mailing anything.
setEmailTransport(emails)
setGoogleVerifier(google)
setRateLimiter(rateLimit)
setSnsGateway(sns)
// The jobs module reaches `lib/prisma`, whose client is built from the URL on import, so it
// is loaded only after that is set above.
const { setCronJobRunners } = await import('@/lib/cron-jobs')
setCronJobRunners(cronJobs.runners)
beforeEach(() => {
  emails.reset()
  google.reset()
  rateLimit.reset()
  sns.reset()
  cronJobs.reset()
})
