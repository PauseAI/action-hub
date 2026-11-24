import { beforeEach, describe, it, expect, vi } from 'vitest'
import { prisma } from '@/lib/prisma'
import { createProject, createVolunteer } from '@/test/factories'
import { emails } from '@/test/fakes/email'
import { runDigestJob } from './digest'

const subscribers = (n: number) =>
  Promise.all(Array.from({ length: n }, () => createVolunteer({ emailDigest: 'fortnightly' })))

describe('runDigestJob', () => {
  beforeEach(async () => {
    await prisma.digestRun.deleteMany()
    await prisma.volunteer.updateMany({ data: { emailDigest: 'none' } })
    await prisma.workItem.updateMany({ data: { status: 'archived' } })
  })

  it('mails each subscriber the new projects and records the run', async () => {
    await createProject({ title: 'Leafleting' })
    const [ana] = await subscribers(2)
    expect(await runDigestJob()).toEqual({ sent: 2, unsent: 0, total: 2, projects: 1 })
    expect(emails.lastTo(ana.email!)?.html).toContain('Leafleting')
    expect(await prisma.digestRun.count()).toBe(1)
  })

  it('reports failed when sends go unsent, so the cron healthcheck alerts', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await createProject()
    await subscribers(3)
    emails.failNext()
    expect(await runDigestJob()).toEqual({
      sent: 2,
      unsent: 1,
      total: 3,
      projects: 1,
      failed: 1,
    })
    // Still recorded, so a rerun does not mail the two who got it again.
    expect(await runDigestJob()).toEqual({ skipped: true, reason: 'sent recently' })
  })

  it('tolerates the odd unsent email in a large run', async () => {
    await createProject()
    await subscribers(21)
    emails.failNext()
    expect(await runDigestJob()).toEqual({ sent: 20, unsent: 1, total: 21, projects: 1 })
  })
})
