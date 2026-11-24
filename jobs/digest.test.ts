import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest'
import { prisma } from '@/lib/prisma'
import { logger } from '@/lib/logger'
import { suppressAddresses } from '@/lib/email-suppression'
import { createProject, createVolunteer } from '@/test/factories'
import { emails } from '@/test/fakes/email'
import { DIGEST_UNSENT_TOLERANCE, runDigestJob } from './digest'

const subscribers = (n: number) =>
  Promise.all(Array.from({ length: n }, () => createVolunteer({ emailDigest: 'fortnightly' })))

describe('runDigestJob', () => {
  beforeEach(async () => {
    await prisma.digestRun.deleteMany()
    await prisma.volunteer.updateMany({ data: { emailDigest: 'none' } })
    await prisma.workItem.updateMany({ data: { status: 'archived' } })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
  })

  const quietErrors = () => vi.spyOn(logger, 'error').mockImplementation(() => logger as never)

  it('mails each subscriber the new projects and records the run', async () => {
    await createProject({ title: 'Leafleting' })
    const [ana] = await subscribers(2)
    expect(await runDigestJob()).toEqual({
      attempted: 2,
      sent: 2,
      unsent: 0,
      suppressed: 0,
      subscribers: 2,
      projects: 1,
    })
    expect(emails.lastTo(ana.email!)?.html).toContain('Leafleting')
    expect(await prisma.digestRun.count()).toBe(1)
  })

  it('reports failed when sends go unsent, so the cron healthcheck alerts', async () => {
    const error = quietErrors()
    await createProject()
    await subscribers(3)
    emails.failNext()
    expect(await runDigestJob()).toMatchObject({ attempted: 3, sent: 2, unsent: 1, failed: 1 })
    expect(error).toHaveBeenCalledWith('[CRON DIGEST] 1 of 3 digest emails were not sent')
    // Still recorded, so a rerun does not mail the two who got it again.
    expect(await runDigestJob()).toEqual({ skipped: true, reason: 'sent recently' })
  })

  it('tolerates the odd unsent email in a large run', async () => {
    quietErrors()
    // Just enough sends that one unsent stays within the tolerance.
    const n = Math.floor(1 / DIGEST_UNSENT_TOLERANCE) + 1
    await createProject()
    await subscribers(n)
    emails.failNext()
    const result = await runDigestJob()
    expect(result).toMatchObject({ attempted: n, sent: n - 1, unsent: 1 })
    expect(result).not.toHaveProperty('failed')
  })

  it('skips suppressed addresses without counting them as failures', async () => {
    await createProject()
    const [bounced] = await subscribers(3)
    await suppressAddresses([bounced.email!], 'bounce', 'Permanent')
    const result = await runDigestJob()
    expect(result).toMatchObject({ attempted: 2, sent: 2, unsent: 0, suppressed: 1 })
    expect(result).not.toHaveProperty('failed')
    expect(emails.to(bounced.email!)).toEqual([])
  })

  it('checks no suppression list without the secret that keys it, as with Resend', async () => {
    vi.stubEnv('EMAIL_HASH_SECRET', '')
    await createProject()
    await subscribers(1)
    expect(await runDigestJob()).toMatchObject({ attempted: 1, sent: 1, suppressed: 0 })
  })
})
