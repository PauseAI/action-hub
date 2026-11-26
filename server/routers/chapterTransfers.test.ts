import { describe, it, expect } from 'vitest'
import { prisma } from '@/lib/prisma'
import {
  createAdmin,
  createChapter,
  createChapterDeputy,
  createChapterLead,
  createLocalGroup,
  createMember,
  createProject,
  createSuperAdmin,
  createVolunteer,
} from '@/test/factories'
import { clientAs } from '@/test/rpc'
import { hashEmail } from '@/lib/auth'
import { emails, linkParam } from '@/test/fakes/email'
import { rateLimit } from '@/test/fakes/rate-limit'

describe('chapter transfers', () => {
  it("asks the destination chapter's staff, who approve the move", async () => {
    const [from, to] = [await createChapter(), await createChapter()]
    const group = await createLocalGroup({ country: from.country, nationalChapterId: from.id })
    const deputy = await createChapterDeputy(from)
    await prisma.volunteer.update({ where: { id: deputy.id }, data: { localGroupId: group.id } })
    const project = await createProject({ nationalChapterId: from.id, assigneeId: deputy.id })
    const destination = await createChapterLead(to)
    const c = clientAs(deputy)

    await expect(c.chapterTransfers.request({ country: from.country })).rejects.toMatchObject({
      message: 'That is already your country',
    })
    await expect(c.chapterTransfers.request({ country: 'Atlantis' })).rejects.toMatchObject({
      message: 'Choose your country from the list',
    })
    expect(await c.chapterTransfers.request({ country: to.country, reason: 'New job' })).toEqual({
      message: 'Request sent',
    })
    await expect(c.chapterTransfers.request({ country: to.country })).rejects.toMatchObject({
      message: 'You already asked to move; cancel that first',
    })
    expect(await c.chapterTransfers.mine()).toMatchObject({
      toCountry: to.country,
      reason: 'New job',
    })
    expect(
      await prisma.notification.count({
        where: { volunteerId: destination.id, type: 'chapter_transfer_request' },
      }),
    ).toBe(1)

    // The chapter they are leaving does not decide.
    const leaving = clientAs(await createChapterDeputy(from))
    expect(await leaving.chapterTransfers.list()).toEqual([])
    const lead = clientAs(destination)
    const [request] = await lead.chapterTransfers.list()
    expect(request).toMatchObject({
      volunteer: { id: deputy.id },
      fromChapterName: from.name,
      toChapterName: to.name,
    })
    await expect(
      leaving.chapterTransfers.decide({ id: request.id, approve: true }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })

    expect(await lead.chapterTransfers.decide({ id: request.id, approve: true })).toEqual({
      message: 'Moved',
    })
    expect(await prisma.volunteer.findUniqueOrThrow({ where: { id: deputy.id } })).toMatchObject({
      nationalChapterId: to.id,
      country: to.country,
      localGroupId: null,
    })
    // No longer staff where they were, but still on their project.
    expect(await prisma.chapterDeputy.findUnique({ where: { volunteerId: deputy.id } })).toBeNull()
    expect(
      (await prisma.workItem.findUniqueOrThrow({ where: { id: project.id } })).assigneeId,
    ).toBe(deputy.id)
    expect(
      await prisma.notification.findFirst({
        where: { volunteerId: deputy.id, type: 'chapter_transfer_decided' },
      }),
    ).toMatchObject({ title: `Moved: you're now in ${to.name}` })
    expect(
      (
        await prisma.chapterAuditEvent.findMany({
          where: { targetVolunteerId: deputy.id },
          orderBy: { id: 'asc' },
        })
      ).map((e) => e.action),
    ).toEqual(['DEPUTY_REMOVED', 'TRANSFER_APPROVED'])
    await expect(
      lead.chapterTransfers.decide({ id: request.id, approve: false }),
    ).rejects.toMatchObject({ message: 'This request has already been answered' })
  })

  it('sends a move to a country with no chapter to the global admins, and can be declined or cancelled', async () => {
    const from = await createChapter()
    const member = await createMember(from)
    const admin = await createSuperAdmin()
    const c = clientAs(member)
    await c.chapterTransfers.request({ country: 'Other' })
    expect(
      await prisma.notification.count({
        where: { volunteerId: admin.id, type: 'chapter_transfer_request' },
      }),
    ).toBe(1)
    const [request] = (await clientAs(admin).chapterTransfers.list({ chapter: 'pool' })).filter(
      (r) => r.volunteer.id === member.id,
    )
    expect(request).toMatchObject({ toChapterName: null })
    await clientAs(admin).chapterTransfers.decide({ id: request.id, approve: false, note: 'Sorry' })
    expect(
      await prisma.chapterTransferRequest.findUniqueOrThrow({ where: { id: request.id } }),
    ).toMatchObject({ status: 'declined', decisionNote: 'Sorry' })
    expect(
      (await prisma.volunteer.findUniqueOrThrow({ where: { id: member.id } })).nationalChapterId,
    ).toBe(from.id)

    await c.chapterTransfers.request({ country: 'Ghana' })
    expect(await c.chapterTransfers.cancel()).toEqual({ message: 'Request cancelled' })
    await expect(c.chapterTransfers.cancel()).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(await c.chapterTransfers.mine()).toBeNull()

    // Approved into the pool, they keep the country they named.
    await c.chapterTransfers.request({ country: 'Ghana' })
    const [ghana] = (await clientAs(await createAdmin()).chapterTransfers.list({})).filter(
      (r) => r.volunteer.id === member.id,
    )
    await clientAs(admin).chapterTransfers.decide({ id: ghana.id, approve: true })
    expect(await prisma.volunteer.findUniqueOrThrow({ where: { id: member.id } })).toMatchObject({
      nationalChapterId: null,
      country: 'Ghana',
    })
    await expect(
      clientAs(admin).chapterTransfers.decide({ id: 999_999, approve: true }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})

describe('chapter moves staff ask for', () => {
  /** Puts `member` on a project `staff` owns, so `staff` can see them from another chapter. */
  const share = async (staff: { id: number }, member: { id: number }) =>
    prisma.workItemInterest.create({
      data: {
        workItemId: (await createProject({ nationalChapterId: null, assigneeId: staff.id })).id,
        volunteerId: member.id,
        status: 'accepted',
        interestType: 'want_to_contribute',
      },
    })
  const notices = (volunteerId: number, type: string) =>
    prisma.notification.findMany({ where: { volunteerId, type }, select: { title: true } })

  it("lets a lead send a member on; the other chapter's staff accept, and both are told", async () => {
    const [from, to] = [await createChapter(), await createChapter()]
    const lead = await createChapterLead(from, { name: 'Sending Lead' })
    const member = await createMember(from, { name: 'Moving On' })
    const destination = await createChapterLead(to)

    expect(
      await clientAs(lead).chapterTransfers.requestFor({
        volunteerId: member.id,
        toChapterId: to.id,
        reason: 'Moved house',
      }),
    ).toEqual({ message: `Asked: ${to.name}'s move for Moving On is waiting for an answer` })
    expect(await notices(destination.id, 'chapter_transfer_request')).toEqual([
      { title: `Sending Lead asks you to take Moving On into ${to.name}` },
    ])
    expect(
      await prisma.chapterAuditEvent.findFirst({
        where: { action: 'TRANSFER_REQUESTED', targetVolunteerId: member.id },
      }),
    ).toMatchObject({ actorId: lead.id, nationalChapterId: from.id })
    // A second request waits for the first.
    await expect(
      clientAs(lead).chapterTransfers.requestFor({ volunteerId: member.id, toChapterId: to.id }),
    ).rejects.toMatchObject({ message: 'Moving On already has a move waiting for an answer' })

    // The asking side does not answer it; the other side does.
    expect(await clientAs(lead).chapterTransfers.list()).toEqual([])
    const [listed] = await clientAs(destination).chapterTransfers.list()
    expect(listed).toMatchObject({
      kind: 'SEND',
      requestedBy: { id: lead.id, name: 'Sending Lead' },
    })
    await expect(
      clientAs(lead).chapterTransfers.decide({ id: listed.id, approve: true }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(
      await clientAs(destination).chapterTransfers.decide({ id: listed.id, approve: true }),
    ).toEqual({ message: 'Moved' })
    expect(await prisma.volunteer.findUnique({ where: { id: member.id } })).toMatchObject({
      nationalChapterId: to.id,
    })
    expect((await notices(member.id, 'chapter_transfer_decided'))[0].title).toMatch(/^Moved: /)
    expect((await notices(lead.id, 'chapter_transfer_decided'))[0].title).toMatch(
      /^Moved: Moving On is now in /,
    )
  })

  it("lets another chapter's staff ask to bring a member in; a refusal is not the member's news", async () => {
    const [home, other] = [await createChapter(), await createChapter()]
    const member = await createMember(home, { name: 'Wanted Elsewhere' })
    const homeDeputy = await createChapterDeputy(home)
    const asker = await createChapterDeputy(other, { name: 'Recruiting Deputy' })
    // Someone they cannot see is not found, however their id is guessed.
    await expect(
      clientAs(asker).chapterTransfers.requestFor({
        volunteerId: member.id,
        toChapterId: other.id,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await share(asker, member)

    await clientAs(asker).chapterTransfers.requestFor({
      volunteerId: member.id,
      toChapterId: other.id,
    })
    expect(await notices(homeDeputy.id, 'chapter_transfer_request')).toEqual([
      { title: `Recruiting Deputy asks to bring Wanted Elsewhere into ${other.name}` },
    ])
    const [listed] = await clientAs(homeDeputy).chapterTransfers.list()
    expect(listed).toMatchObject({ kind: 'BRING', volunteer: { id: member.id } })
    expect(await clientAs(asker).chapterTransfers.list()).toEqual([])
    await clientAs(homeDeputy).chapterTransfers.decide({ id: listed.id, approve: false })
    expect(await prisma.volunteer.findUnique({ where: { id: member.id } })).toMatchObject({
      nationalChapterId: home.id,
    })
    expect(await notices(member.id, 'chapter_transfer_decided')).toEqual([])
    expect((await notices(asker.id, 'chapter_transfer_decided'))[0].title).toMatch(
      /^Declined: moving Wanted Elsewhere/,
    )
  })

  it('asks the global admins to let someone in the pool be brought in', async () => {
    const chapter = await createChapter()
    const pooled = await createVolunteer({ name: 'Pool Swimmer' })
    const admin = await createAdmin()
    const asker = await createChapterLead(chapter)
    await share(asker, pooled)
    await clientAs(asker).chapterTransfers.requestFor({
      volunteerId: pooled.id,
      toChapterId: chapter.id,
    })
    const [listed] = await clientAs(admin).chapterTransfers.list({ chapter: 'pool' })
    expect(listed).toMatchObject({ kind: 'BRING', volunteer: { id: pooled.id } })
    await clientAs(admin).chapterTransfers.decide({ id: listed.id, approve: true })
    expect(await prisma.volunteer.findUnique({ where: { id: pooled.id } })).toMatchObject({
      nationalChapterId: chapter.id,
    })
  })

  it("moves a chapter's own member to the pool at once, and tells them", async () => {
    const chapter = await createChapter()
    const member = await createMember(chapter, { name: 'Out To Pool' })
    expect(
      await clientAs(await createChapterDeputy(chapter)).chapterTransfers.requestFor({
        volunteerId: member.id,
        toChapterId: null,
      }),
    ).toEqual({ message: 'Out To Pool is in the holding pool' })
    expect(await prisma.volunteer.findUnique({ where: { id: member.id } })).toMatchObject({
      nationalChapterId: null,
    })
    expect(await notices(member.id, 'chapter_transfer_decided')).toEqual([
      { title: "Moved: you're now in the holding pool" },
    ])
  })

  it('refuses anyone else, and requests that make no sense', async () => {
    const [a, b, c] = [await createChapter(), await createChapter(), await createChapter()]
    const lead = await createChapterLead(a)
    const member = await createMember(a)
    const ask = (who: Parameters<typeof clientAs>[0], toChapterId: number | null, id = member.id) =>
      clientAs(who).chapterTransfers.requestFor({ volunteerId: id, toChapterId })

    await expect(ask(await createMember(a), b.id)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    // A third chapter's staff can neither send A's member nor bring them anywhere but their own.
    await expect(ask(await createChapterLead(c), b.id)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(ask(await createChapterLead(c), null)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(ask(lead, b.id, lead.id)).rejects.toMatchObject({
      message: 'Ask to move yourself from your settings',
    })
    await expect(ask(lead, a.id)).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    await expect(ask(lead, 999_999)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(ask(lead, b.id, 999_999)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    const applicant = await createMember(a, { approvalStatus: 'pending' })
    await expect(ask(lead, b.id, applicant.id)).rejects.toMatchObject({
      message: 'Only an approved member can be moved',
    })
    const duplicate = await createMember(a, { duplicateOfId: member.id })
    await expect(ask(lead, b.id, duplicate.id)).rejects.toMatchObject({
      message: 'Only an approved member can be moved',
    })
  })

  it('leaves a lead or deputy to whoever appoints them', async () => {
    const [a, b] = [await createChapter(), await createChapter()]
    const lead = await createChapterLead(a, { name: 'The Lead' })
    const [deputy, other] = [await createChapterDeputy(a), await createChapterDeputy(a)]
    const ask = (who: Parameters<typeof clientAs>[0], id: number, toChapterId: number | null) =>
      clientAs(who).chapterTransfers.requestFor({ volunteerId: id, toChapterId })

    // A deputy can neither move the lead nor a fellow deputy, to the pool or elsewhere.
    for (const [id, to] of [
      [lead.id, null],
      [lead.id, b.id],
      [other.id, null],
    ] as const) {
      await expect(ask(deputy, id, to)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    }
    // The lead may move a deputy; only a global admin moves the lead.
    expect(await ask(lead, other.id, null)).toMatchObject({ message: expect.any(String) })
    await expect(ask(lead, lead.id, null)).rejects.toMatchObject({ code: 'BAD_REQUEST' })

    // Bringing in another chapter's lead needs a global admin's yes, not a deputy's.
    const asker = await createChapterLead(b)
    await share(asker, lead)
    await ask(asker, lead.id, b.id)
    const [request] = await clientAs(deputy).chapterTransfers.list()
    await expect(
      clientAs(deputy).chapterTransfers.decide({ id: request.id, approve: true }),
    ).rejects.toMatchObject({
      message: 'The Lead helps run the chapter; whoever appoints them must agree',
    })
    // Declining is anyone's, and lands in the declining chapter's log.
    await clientAs(deputy).chapterTransfers.decide({ id: request.id, approve: false })
    expect(
      await prisma.chapterAuditEvent.findFirst({
        where: { action: 'TRANSFER_DECLINED', targetVolunteerId: lead.id },
      }),
    ).toMatchObject({ nationalChapterId: a.id })
  })

  it("keeps staff's requests out of the member's own, and clears them when the member moves", async () => {
    const [a, b] = [await createChapter(), await createChapter()]
    const lead = await createChapterLead(a)
    const member = await createMember(a)
    const destination = await createChapterLead(b)
    await clientAs(lead).chapterTransfers.requestFor({ volunteerId: member.id, toChapterId: b.id })

    const own = clientAs(member).chapterTransfers
    expect(await own.mine()).toBeNull()
    await expect(own.cancel()).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(own.request({ country: b.country })).rejects.toMatchObject({
      message: "Your chapter's organisers are already arranging a move for you",
    })

    // Moving them to the pool cancels the request, and its notice to the other chapter.
    await clientAs(lead).chapterTransfers.requestFor({ volunteerId: member.id, toChapterId: null })
    expect(await notices(destination.id, 'chapter_transfer_request')).toEqual([])
    expect(await clientAs(destination).chapterTransfers.list()).toEqual([])

    // A global admin's direct move clears them too.
    const again = await createMember(a)
    await clientAs(lead).chapterTransfers.requestFor({ volunteerId: again.id, toChapterId: b.id })
    await clientAs(await createAdmin()).admin.chapters.reassign({
      volunteerId: again.id,
      chapterId: b.id,
    })
    expect(await notices(destination.id, 'chapter_transfer_request')).toEqual([])
  })

  it('lets the asking side withdraw a move nobody has answered', async () => {
    const [a, b] = [await createChapter(), await createChapter()]
    const lead = await createChapterLead(a)
    const member = await createMember(a)
    const other = await createChapterLead(b)
    await clientAs(lead).chapterTransfers.requestFor({ volunteerId: member.id, toChapterId: b.id })
    const [request] = await clientAs(other).chapterTransfers.list()

    await expect(
      clientAs(other).chapterTransfers.withdraw({ id: request.id }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(await clientAs(lead).chapterTransfers.withdraw({ id: request.id })).toEqual({
      message: 'Request withdrawn',
    })
    await expect(
      clientAs(lead).chapterTransfers.withdraw({ id: request.id }),
    ).rejects.toMatchObject({ message: 'This request has already been answered' })
    // A member's own request is theirs to cancel, not staff's.
    await clientAs(member).chapterTransfers.request({ country: b.country })
    const own = await prisma.chapterTransferRequest.findFirstOrThrow({
      where: { volunteerId: member.id, status: 'pending' },
    })
    await expect(clientAs(lead).chapterTransfers.withdraw({ id: own.id })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
  })
})

describe('chapterTransfers.inviteToChapter', () => {
  it('sends someone new a link to sign up with the chapter filled in', async () => {
    const chapter = await createChapter()
    const lead = await createChapterLead(chapter, { name: 'Inviting Lead' })
    expect(
      await clientAs(lead).chapterTransfers.inviteToChapter({
        chapterId: chapter.id,
        email: ' New.Person@Example.org ',
      }),
    ).toEqual({ message: 'Invite sent to new.person@example.org', existing: null })
    const sent = emails.lastTo('new.person@example.org')
    expect(sent?.subject).toBe(
      `Inviting Lead invited you to join the PauseAI ${chapter.name} chapter`,
    )
    expect(linkParam(sent!, 'email')).toBe('new.person@example.org')
    expect(linkParam(sent!, 'country')).toBe(chapter.country)
  })

  it('names someone already elsewhere, and asks their chapter to let them come', async () => {
    const [mine, theirs] = [await createChapter(), await createChapter()]
    const deputy = await createChapterDeputy(mine, { name: 'Inviting Deputy' })
    const homeLead = await createChapterLead(theirs)
    const elsewhere = await createMember(theirs, {
      name: 'Already Here',
      email: 'here@example.org',
    })
    const invite = (bring = false) =>
      clientAs(deputy).chapterTransfers.inviteToChapter({
        chapterId: mine.id,
        email: 'HERE@example.org',
        bring,
        reason: bring ? 'They live here now' : undefined,
      })

    const sent = emails.sent.length
    expect(await invite()).toEqual({
      message: `Already Here is already on Action Hub, in the ${theirs.name} chapter`,
      existing: { name: 'Already Here', chapterName: theirs.name },
    })
    expect(emails.sent.length).toBe(sent)
    expect(
      await prisma.chapterTransferRequest.count({ where: { volunteerId: elsewhere.id } }),
    ).toBe(0)

    // The deputy cannot see their profile, and needs not to.
    expect((await invite(true)).message).toBe(
      `Asked: ${mine.name}'s move for Already Here is waiting for an answer`,
    )
    expect(
      await prisma.chapterTransferRequest.findFirst({ where: { volunteerId: elsewhere.id } }),
    ).toMatchObject({ kind: 'BRING', requestedById: deputy.id, reason: 'They live here now' })
    const [request] = await clientAs(homeLead).chapterTransfers.list()
    expect(request.volunteer.id).toBe(elsewhere.id)

    // Someone in the pool is named as being there.
    await createVolunteer({ name: 'Pool Person', email: 'pool@example.org' })
    expect(
      await clientAs(deputy).chapterTransfers.inviteToChapter({
        chapterId: mine.id,
        email: 'pool@example.org',
      }),
    ).toMatchObject({ existing: { name: 'Pool Person', chapterName: null } })
  })

  it('names nobody it cannot move, and sends no link that sign-up would refuse', async () => {
    const chapter = await createChapter()
    const lead = await createChapterLead(chapter)
    const other = await createChapter()
    const invite = (email: string) =>
      clientAs(lead).chapterTransfers.inviteToChapter({ chapterId: chapter.id, email })
    const cannotMove = { message: 'This address already has an account that cannot be moved yet' }

    await createMember(other, { email: 'applying@example.org', approvalStatus: 'pending' })
    await expect(invite('applying@example.org')).rejects.toMatchObject(cannotMove)
    const kept = await createMember(other)
    await createMember(other, { email: 'second@example.org', duplicateOfId: kept.id })
    await expect(invite('second@example.org')).rejects.toMatchObject(cannotMove)
    await createMember(other, { email: 'closed@example.org', deletedAt: new Date() })
    await expect(invite('closed@example.org')).rejects.toMatchObject({
      message: 'This address belonged to an account that has been closed',
    })
    await prisma.anonymisedEmail.create({ data: { emailHash: hashEmail('turned@example.org') } })
    await expect(invite('turned@example.org')).rejects.toMatchObject({
      message: 'This address was turned down before; a global admin can let them apply again',
    })
    await prisma.anonymisedEmail.update({
      where: { emailHash: hashEmail('turned@example.org') },
      data: { reapplyAllowedAt: new Date() },
    })
    expect((await invite('turned@example.org')).message).toBe('Invite sent to turned@example.org')

    // A send that fails is reported, not passed off as sent.
    emails.failNext()
    await expect(invite('unlucky@example.org')).rejects.toMatchObject({
      message: 'The invite email could not be sent; try again later',
    })

    // A global admin cannot ask to bring themselves in.
    const admin = await createAdmin({ nationalChapterId: other.id, country: other.country })
    await expect(
      clientAs(admin).chapterTransfers.inviteToChapter({
        chapterId: chapter.id,
        email: admin.email as string,
        bring: true,
      }),
    ).rejects.toMatchObject({ message: 'Ask to move yourself from your settings' })
  })

  it("refuses someone already in the chapter, and anyone who doesn't run it", async () => {
    const [mine, other] = [await createChapter(), await createChapter()]
    const lead = await createChapterLead(mine)
    await createMember(mine, { name: 'Already Ours', email: 'ours@example.org' })
    const invite = (who: Parameters<typeof clientAs>[0], email = 'someone@example.org') =>
      clientAs(who).chapterTransfers.inviteToChapter({ chapterId: mine.id, email })
    await expect(invite(lead, 'ours@example.org')).rejects.toMatchObject({
      message: `Already Ours is already a member of ${mine.name}`,
    })
    await expect(invite(await createChapterLead(other))).rejects.toMatchObject({
      code: 'FORBIDDEN',
    })
    await expect(invite(await createMember(mine))).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(
      clientAs(await createAdmin()).chapterTransfers.inviteToChapter({
        chapterId: 999_999,
        email: 'x@example.org',
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
    rateLimit.denyNext()
    await expect(invite(lead)).rejects.toMatchObject({ code: 'TOO_MANY_REQUESTS' })
  })
})
