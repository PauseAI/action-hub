import { describe, it, expect } from 'vitest'
import {
  createChapter,
  createChapterDeputy,
  createMember,
  createSuperAdmin,
  createVolunteer,
} from '@/test/factories'
import { emails } from '@/test/fakes/email'
import { prisma } from '@/lib/prisma'
import { suppressAddresses, suppressionKey } from '@/lib/email-suppression'
import { runApplicationsAnonymisationJob, runApplicationsSummaryJob } from './applications'

describe('runApplicationsSummaryJob', () => {
  it("tells each chapter's staff of their applicants, and the global admins of the rest", async () => {
    const [staffed, unstaffed] = [await createChapter(), await createChapter()]
    const deputy = await createChapterDeputy(staffed)
    const admin = await createSuperAdmin()
    const pending = { approvalStatus: 'pending' as const }
    await createMember(staffed, pending)
    await createMember(staffed, pending)
    await createMember(unstaffed, pending)
    await createVolunteer(pending)

    expect(await runApplicationsSummaryJob()).toMatchObject({ pending: 4 })
    expect(emails.lastTo(deputy.email!).html).toContain('2')
    // The unstaffed chapter's one and the pool's one.
    expect(emails.lastTo(admin.email!).html).toContain('2')
    expect(await runApplicationsSummaryJob()).toEqual({
      skipped: true,
      reason: 'already sent today',
    })
  })
})

describe('runApplicationsAnonymisationJob', () => {
  it('lifts the suppression of a confirmed address it anonymises, and only that', async () => {
    const longAgo = new Date('2020-01-01T00:00:00Z')
    const rejected = { approvalStatus: 'rejected' as const, rejectedAt: longAgo }
    const confirmed = await createVolunteer({ ...rejected, emailConfirmed: true })
    const unconfirmed = await createVolunteer({ ...rejected, emailConfirmed: false })
    await suppressAddresses([confirmed.email!, unconfirmed.email!], 'complaint', 'abuse')

    await runApplicationsAnonymisationJob()
    expect(await prisma.volunteer.findUniqueOrThrow({ where: { id: confirmed.id } })).toMatchObject(
      {
        email: null,
      },
    )
    expect(await prisma.emailSuppression.findMany({ select: { emailHash: true } })).toEqual([
      { emailHash: suppressionKey(unconfirmed.email!) },
    ])
  })
})
