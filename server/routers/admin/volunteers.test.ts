import { describe, it, expect } from 'vitest'
import { prisma } from '@/lib/prisma'
import {
  createVolunteer,
  createAdmin,
  createProject,
  createTask,
  createQuickTask,
  createSkill,
  createChapter,
  createChapterDeputy,
  createChapterLead,
  createMember,
  createCoordinator,
  TEST_PASSWORD,
} from '@/test/factories'
import { anon, clientAs } from '@/test/rpc'
import { emails, linkParam } from '@/test/fakes/email'
import { rateLimit } from '@/test/fakes/rate-limit'
import { dismissDuplicatePair } from '@/lib/duplicate-accounts'
import { finishStaffMerge } from '@/lib/staff-merge'
import { SUSPENDED_MESSAGE } from '@/lib/suspension'
import { createSession, getCurrentVolunteer } from '@/lib/auth'
import { authenticateApiToken, createApiToken } from '@/lib/api-tokens'
import { withoutAdminRights } from '@/lib/view-as'

const subjects = {
  merged: 'Your two Action Hub accounts are now one',
  confirmMerge: 'Are these both your Action Hub accounts?',
  suspended: 'Your Action Hub account is suspended',
  lifted: 'Your Action Hub account is no longer suspended',
}

describe('admin.volunteers', () => {
  it('getById returns the full admin view of a volunteer', async () => {
    const admin = await createAdmin()
    const c = clientAs(admin)
    await expect(c.admin.volunteers.getById({ id: 999_999 })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })

    const skill = await createSkill()
    const vol = await createVolunteer({
      skills: { create: [{ skillId: skill.id, proficiencyLevel: 'pro' }] },
    })
    await c.admin.notes.create({ volunteerId: vol.id, content: 'a note' })
    await c.admin.volunteers.addEndorsement({
      volunteerId: vol.id,
      skillId: skill.id,
      notes: 'great',
    })
    const project = await createProject({ assigneeId: vol.id })
    await createQuickTask({ assigneeId: vol.id, skillId: skill.id })
    await createQuickTask({ assigneeId: vol.id })

    const view = await c.admin.volunteers.getById({ id: vol.id })
    expect(view.email).toBe(vol.email)
    expect(view.skills).toEqual([
      expect.objectContaining({ id: skill.id, proficiencyLevel: 'pro' }),
    ])
    expect(view.adminNotes).toEqual([
      expect.objectContaining({ content: 'a note', authorName: admin.name }),
    ])
    expect(view.endorsements).toEqual([
      expect.objectContaining({
        skillName: skill.name,
        endorsedByName: admin.name,
        notes: 'great',
        rating: 'verified',
      }),
    ])
    expect(view.quickTasks.map((t) => t.skillName).sort()).toEqual([null, skill.name].sort())
    expect(view.projectHistory).toEqual([
      expect.objectContaining({ id: project.id, ownerId: vol.id }),
    ])
  })

  it('lists and upserts endorsements', async () => {
    const admin = await createAdmin()
    const c = clientAs(admin)
    const skill = await createSkill()
    const vol = await createVolunteer()
    expect(await c.admin.volunteers.listEndorsements({ volunteerId: vol.id })).toEqual([])
    expect(
      await c.admin.volunteers.addEndorsement({ volunteerId: vol.id, skillId: skill.id }),
    ).toEqual({ message: 'Skill endorsed' })
    await c.admin.volunteers.addEndorsement({
      volunteerId: vol.id,
      skillId: skill.id,
      rating: 'strong',
      source: 'quick_task',
      sourceId: 5,
      notes: 'n',
    })
    const list = await c.admin.volunteers.listEndorsements({ volunteerId: vol.id })
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({
      rating: 'strong',
      source: 'quick_task',
      sourceId: 5,
      notes: 'n',
      skillCategory: expect.any(String),
    })
    expect(await prisma.skillEndorsement.count({ where: { volunteerId: vol.id } })).toBe(1)
  })
})

describe('admin.volunteers.markDuplicate', () => {
  it('links a second account to the one kept, hides it, and notes it on both', async () => {
    const admin = await createAdmin()
    const c = clientAs(admin)
    const kept = await createVolunteer({ name: 'Sam Twin', email: 'sam-new@example.com' })
    const old = await createVolunteer({ name: 'Sam Twin', email: 'sam-old@example.com' })
    const noEmail = await createVolunteer({ name: 'Sam Noemail', email: null })

    expect(await c.admin.volunteers.markDuplicate({ id: old.id, duplicateOfId: kept.id })).toEqual({
      message: 'Sam Twin is marked as a duplicate of Sam Twin',
    })
    await c.admin.volunteers.markDuplicate({ id: noEmail.id, duplicateOfId: kept.id })

    const keptView = await c.admin.volunteers.getById({ id: kept.id })
    expect(keptView.duplicateOf).toBeNull()
    expect(keptView.duplicates.map((d) => d.id).sort()).toEqual([old.id, noEmail.id].sort())
    expect(keptView.adminNotes.map((n) => n.content)).toEqual(
      expect.arrayContaining([
        'Sam Twin (sam-old@example.com) marked as a duplicate of this account.',
        'Sam Noemail marked as a duplicate of this account.',
      ]),
    )
    const oldView = await c.admin.volunteers.getById({ id: old.id })
    expect(oldView.duplicateOf).toEqual({ id: kept.id, name: 'Sam Twin', email: kept.email })
    expect(oldView.adminNotes[0].content).toBe(
      'Marked as a duplicate of Sam Twin (sam-new@example.com).',
    )

    // Still in the directory, marked for a global admin.
    const listed = (await c.volunteers.list({ search: 'Sam' })).volunteers
    expect(listed.find((v) => v.id === kept.id)?.duplicateOf).toBeNull()
    expect(listed.find((v) => v.id === old.id)?.duplicateOf).toEqual({
      id: kept.id,
      name: 'Sam Twin',
    })
    expect((await c.volunteers.getById({ id: old.id })).duplicateOf).toEqual({
      id: kept.id,
      name: 'Sam Twin',
    })

    // A third account becomes the keeper, and the marks follow it.
    const newest = await createVolunteer({ name: 'Sam Newest' })
    await c.admin.volunteers.markDuplicate({ id: kept.id, duplicateOfId: newest.id })
    expect(
      (await c.admin.volunteers.getById({ id: newest.id })).duplicates.map((d) => d.id).sort(),
    ).toEqual([kept.id, old.id, noEmail.id].sort())

    expect(await c.admin.volunteers.markDuplicate({ id: old.id, duplicateOfId: null })).toEqual({
      message: 'Sam Twin is no longer marked as a duplicate',
    })
    const cleared = await c.admin.volunteers.getById({ id: old.id })
    expect(cleared.duplicateOf).toBeNull()
    expect(cleared.adminNotes[0].content).toBe('No longer marked as a duplicate.')
  })

  it('refuses a mark that would chain, loop, or leave a chapter role on a duplicate', async () => {
    const c = clientAs(await createAdmin())
    const chapter = await createChapter({ name: 'Ruritania' })
    const lead = await createChapterLead(chapter, { name: 'Lee Lead' })
    const deputy = await createChapterDeputy(chapter, { name: 'Dee Deputy' })
    const kept = await createMember(chapter, { name: 'Kim Kept' })
    const old = await createMember(chapter, { name: 'Kim Old' })
    await c.admin.volunteers.markDuplicate({ id: old.id, duplicateOfId: kept.id })

    const refused = (id: number, duplicateOfId: number | null) =>
      expect(c.admin.volunteers.markDuplicate({ id, duplicateOfId })).rejects
    await refused(kept.id, kept.id).toMatchObject({
      message: 'An account cannot be a duplicate of itself',
    })
    await refused(kept.id, null).toMatchObject({ message: 'Kim Kept is not marked as a duplicate' })
    await refused(lead.id, old.id).toMatchObject({
      message: 'Kim Old is itself marked as a duplicate',
    })
    await refused(999_999, kept.id).toMatchObject({ code: 'NOT_FOUND' })
    await refused(kept.id, 999_999).toMatchObject({ code: 'NOT_FOUND' })
    await refused(lead.id, kept.id).toMatchObject({
      message:
        'Lee Lead leads the Ruritania chapter. Give the role to the account you are keeping first.',
    })
    await refused(deputy.id, kept.id).toMatchObject({
      message:
        'Dee Deputy is a deputy of the Ruritania chapter. Give the role to the account you are keeping first.',
    })

    // Nor is a duplicate given a role.
    await expect(
      c.admin.chapters.appointLead({ chapterId: chapter.id, volunteerId: old.id }),
    ).rejects.toMatchObject({
      message: 'Kim Old is a duplicate account. Appoint Kim Kept instead.',
    })
    await expect(
      clientAs(lead).admin.chapters.appointDeputy({ chapterId: chapter.id, volunteerId: old.id }),
    ).rejects.toMatchObject({
      message: 'Kim Old is a duplicate account. Appoint Kim Kept instead.',
    })
    const members = (await c.admin.chapters.get({ chapterId: chapter.id })).members
    expect(members.find((m) => m.id === old.id)?.duplicateOf).toEqual({
      id: kept.id,
      name: 'Kim Kept',
    })

    // Only a global admin marks accounts.
    await expect(
      clientAs(lead).admin.volunteers.markDuplicate({ id: kept.id, duplicateOfId: null }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })
})

describe('admin.volunteers.possibleDuplicates', () => {
  it('pairs accounts with the same name, Discord handle or phone number', async () => {
    const admin = await createAdmin()
    const c = clientAs(admin)
    const chapter = await createChapter({ name: 'Freedonia' })
    const jo = await createChapterLead(chapter, {
      name: 'Jo Bloggs',
      discordHandle: 'JoB#1',
      signalNumber: '+44 7700 900123',
    })
    const accented = await createVolunteer({ name: '  jö   BLOGGS ' })
    const handle = await createVolunteer({ name: 'Joanne B', discordHandle: ' job#1 ' })
    const phone = await createVolunteer({ name: 'J. B.', whatsappNumber: '+447700900123' })
    const short = await createVolunteer({ name: 'Short One', signalNumber: '12' })
    await createVolunteer({ name: 'Short Two', signalNumber: '12' })
    const deputy = await createChapterDeputy(chapter, { name: 'Dee Same', discordHandle: 'dee' })
    const deputyTwin = await createVolunteer({ name: 'Dee Same', discordHandle: 'DEE' })

    const pairs = await c.admin.volunteers.possibleDuplicates({ volunteerId: jo.id })
    expect(pairs.map((p) => [p.a.id, p.b.id, p.reasons])).toEqual([
      [jo.id, accented.id, ['name']],
      [jo.id, handle.id, ['discord']],
      [jo.id, phone.id, ['phone']],
    ])
    expect(pairs[0].a).toMatchObject({ chapterName: 'Freedonia', role: 'Lead of Freedonia' })
    expect(pairs[0].b).toMatchObject({ chapterName: null, role: null })
    // Too few digits to count as a number.
    expect(await c.admin.volunteers.possibleDuplicates({ volunteerId: short.id })).toEqual([])
    const [both] = await c.admin.volunteers.possibleDuplicates({ volunteerId: deputy.id })
    expect(both).toMatchObject({
      a: { id: deputy.id, role: 'Deputy of Freedonia' },
      b: { id: deputyTwin.id },
      reasons: ['discord', 'name'],
    })
    const all = await c.admin.volunteers.possibleDuplicates({})
    expect(all.map((p) => [p.a.id, p.b.id])).toContainEqual([deputy.id, deputyTwin.id])
    expect((await c.admin.overview.counts()).possibleDuplicates).toBe(all.length)

    // Said to be two people, or marked as a duplicate: no longer paired.
    expect(await c.admin.volunteers.dismissDuplicate({ ids: [handle.id, jo.id] })).toEqual({
      message: 'Marked as different people',
    })
    await c.admin.volunteers.dismissDuplicate({ ids: [jo.id, handle.id] })
    await c.admin.volunteers.markDuplicate({ id: phone.id, duplicateOfId: jo.id })
    expect(
      (await c.admin.volunteers.possibleDuplicates({ volunteerId: jo.id })).map((p) => p.b.id),
    ).toEqual([accented.id])
    await expect(
      c.admin.volunteers.dismissDuplicate({ ids: [jo.id, 999_999] }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })

    // Only a global admin is shown them.
    const lead = clientAs(jo)
    expect((await lead.admin.overview.counts()).possibleDuplicates).toBe(0)
    await expect(lead.admin.volunteers.possibleDuplicates({})).rejects.toMatchObject({
      code: 'FORBIDDEN',
    })
  })
})

describe('admin.emailPreview', () => {
  it('lists every registered preview and renders each', async () => {
    const c = clientAs(await createAdmin())
    const { types } = await c.admin.emailPreview.types()
    expect(types.length).toBeGreaterThan(10)
    for (const type of types) {
      const { subject, html } = await c.admin.emailPreview.preview({ type })
      expect(subject).toBeTruthy()
      expect(html).toMatch(/^<!DOCTYPE html/i)
    }
    await expect(c.admin.emailPreview.preview({ type: 'nope' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
  })
})

describe('admin.volunteers.merge', () => {
  const merge = (who: Parameters<typeof clientAs>[0], keptId: number, mergedId: number) =>
    clientAs(who).admin.volunteers.merge({ keptId, mergedId })

  it('merges at once only two confirmed addresses that reach one mailbox, and tells it once', async () => {
    const chapter = await createChapter()
    const lead = await createChapterLead(chapter)
    const kept = await createMember(chapter, { name: 'Sam Twice', email: 'sam.twice@gmail.com' })
    const second = await createMember(chapter, {
      name: 'S Twice',
      email: 'samtwice+old@gmail.com',
      duplicateOfId: kept.id,
    })
    const sent = emails.sent.length
    // The one email failing does not undo or refuse the merge.
    emails.failNext()

    expect(await merge(lead, kept.id, second.id)).toEqual({
      message: "S Twice's account is merged into Sam Twice's",
    })
    expect(await prisma.volunteer.findUnique({ where: { id: second.id } })).toMatchObject({
      mergedIntoId: kept.id,
      deletedAt: expect.any(Date),
    })
    expect(
      await prisma.chapterAuditEvent.findFirst({
        where: { action: 'ACCOUNT_MERGED', targetVolunteerId: kept.id },
      }),
    ).toMatchObject({
      actorId: lead.id,
      nationalChapterId: chapter.id,
      details: { mergedId: second.id, mailbox: true },
    })
    expect(emails.sent.length).toBe(sent)
    // Merged again the same way, a working send tells the one mailbox once.
    const third = await createMember(chapter, {
      name: 'Sam T',
      email: 'sam.t.wice@gmail.com',
    })
    await merge(lead, kept.id, third.id)
    expect(emails.sent.length).toBe(sent + 1)
    const notice = emails.lastTo('sam.twice@gmail.com')
    expect(notice?.subject).toBe(subjects.merged)
    expect(notice?.html).toContain('Sign in from now on with')
    expect(notice?.html).toContain('tech-support@pauseai.info')
  })

  it('merges nothing on a Discord handle or number either account could have typed in', async () => {
    const chapter = await createChapter()
    const lead = await createChapterLead(chapter)
    // Someone sets a member's handle and number on their own account to pass as them.
    const victim = await createMember(chapter, {
      name: 'Real Person',
      email: 'real@example.org',
      discordHandle: 'real#1',
      signalNumber: '+44 7700 900222',
    })
    const impostor = await createMember(chapter, {
      name: 'Real Person',
      email: 'impostor@example.org',
      discordHandle: 'REAL#1',
      signalNumber: '447700900222',
    })
    expect(await merge(lead, impostor.id, victim.id)).toEqual({
      message: 'Sent Real Person a link at each address; they merge once both are followed',
    })
    // Nothing moved: only both mailboxes confirming would merge them.
    expect(await prisma.volunteer.findUnique({ where: { id: victim.id } })).toMatchObject({
      mergedIntoId: null,
      deletedAt: null,
    })
    expect(emails.lastTo('real@example.org')?.subject).toBe(subjects.confirmMerge)
  })

  it("never puts another account's sign-in onto the one kept", async () => {
    const chapter = await createChapter()
    const admin = await createAdmin()
    // An account with an unconfirmed address, such as a coordinator's, kept over a confirmed one.
    const coordinator = await createCoordinator(chapter, {
      name: 'Cora Coord',
      email: 'cora@example.org',
      emailConfirmed: false,
    })
    const alt = await createMember(chapter, { name: 'Cora Coord', email: 'alt@example.org' })
    await expect(merge(admin, coordinator.id, alt.id)).rejects.toMatchObject({
      message: "Keep the account whose address is confirmed: Cora Coord's",
    })
    // A second admin's approval keeps the kept account's own address and password.
    const kept = await createMember(chapter, { name: 'Kit Same', email: 'kit@example.org' })
    const other = await createMember(chapter, {
      name: 'Kit Same',
      email: 'kit.other@example.org',
      emailConfirmed: false,
    })
    const before = await prisma.volunteer.findUniqueOrThrow({ where: { id: kept.id } })
    await merge(admin, kept.id, other.id)
    const request = await prisma.staffMergeRequest.findFirstOrThrow({ where: { keptId: kept.id } })
    await clientAs(await createAdmin()).admin.volunteers.approveMerge({ id: request.id })
    expect(await prisma.volunteer.findUniqueOrThrow({ where: { id: kept.id } })).toMatchObject({
      email: before.email,
      passwordHash: before.passwordHash,
    })
    // Only a confirmed address is told; an unconfirmed one may not be the person's.
    expect(emails.lastTo('kit@example.org')?.subject).toBe(subjects.merged)
    expect(emails.to('kit.other@example.org')).toEqual([])
  })

  it('checks again once the accounts are locked', async () => {
    const chapter = await createChapter()
    const a = await createMember(chapter, { name: 'Lo Ck', email: 'lock@gmail.com' })
    const b = await createMember(chapter, { name: 'Lo Ck', email: 'l.ock@gmail.com' })
    const admin = await createAdmin()
    // Recorded as two people after the caller looked: the merge is refused, and nothing moves.
    await dismissDuplicatePair([a.id, b.id], admin.id)
    await expect(finishStaffMerge(a, b, admin.id, { mailbox: true })).rejects.toMatchObject({
      message: 'These accounts are on record as two different people',
    })
    const c = await createMember(chapter, { name: 'Mo Ved', email: 'moved@gmail.com' })
    const d = await createMember(chapter, { name: 'Mo Ved', email: 'm.oved@gmail.com' })
    // One address changed after the caller looked.
    await prisma.volunteer.update({ where: { id: d.id }, data: { email: 'else@example.org' } })
    await expect(finishStaffMerge(c, d, admin.id, { mailbox: true })).rejects.toMatchObject({
      message: 'These accounts no longer share a mailbox',
    })
    for (const id of [b.id, d.id]) {
      expect(await prisma.volunteer.findUnique({ where: { id } })).toMatchObject({
        deletedAt: null,
      })
    }
    expect(
      await prisma.chapterAuditEvent.count({ where: { targetVolunteerId: { in: [a.id, c.id] } } }),
    ).toBe(0)
  })

  it("refuses anyone else, a pair on record as two people, and the merger's own", async () => {
    const [chapter, other] = [await createChapter(), await createChapter()]
    const lead = await createChapterLead(chapter)
    const a = await createMember(chapter, { name: 'Kim Same', email: 'kim@gmail.com' })
    const b = await createMember(chapter, { name: 'Kim Other', email: 'k.im@gmail.com' })
    const elsewhere = await createMember(other, { name: 'Kim Away', email: 'ki.m@gmail.com' })
    const unconfirmed = await createMember(chapter, { name: 'Kim Same', emailConfirmed: false })

    await expect(merge(await createChapterDeputy(chapter), a.id, b.id)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
    await expect(merge(lead, a.id, elsewhere.id)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(merge(await createMember(chapter), a.id, b.id)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    })
    // A lead cannot ask a second admin; both addresses must be confirmed for them.
    await expect(merge(lead, a.id, unconfirmed.id)).rejects.toMatchObject({
      message: expect.stringContaining('Both accounts need a confirmed address'),
    })
    await expect(merge(lead, lead.id, a.id)).rejects.toMatchObject({
      message: 'Merge your own accounts from your settings',
    })
    await expect(merge(lead, a.id, 999_999)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    const admin = await createAdmin({ nationalChapterId: chapter.id, country: chapter.country })
    await expect(merge(lead, a.id, admin.id)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await dismissDuplicatePair([a.id, b.id], lead.id)
    await expect(merge(lead, a.id, b.id)).rejects.toMatchObject({
      message: 'These accounts are on record as two different people',
    })
    // A global admin may merge across chapters.
    expect(await merge(await createAdmin(), a.id, elsewhere.id)).toMatchObject({
      message: expect.any(String),
    })
  })
})

describe('admin.volunteers.mergeCandidates', () => {
  it('offers look-alikes, saying which need proof and which side a role keeps', async () => {
    const [chapter, other] = [await createChapter(), await createChapter()]
    const lead = await createChapterLead(chapter)
    const self = await createMember(chapter, { name: 'Pat Pair', email: 'pat@gmail.com' })
    const marked = await createMember(chapter, {
      name: 'Pat Pair',
      email: 'p.at@gmail.com',
      duplicateOfId: self.id,
    })
    // Same name only: offered, but needs proof. On record as two people: not offered.
    const namesake = await createMember(chapter, { name: 'Pat Pair' })
    const apart = await createMember(chapter, { name: 'Pat Pair' })
    await dismissDuplicatePair([self.id, apart.id], lead.id)
    const elsewhere = await createMember(other, { name: 'Pat Pair' })
    // A deputy look-alike: a merge must keep their account.
    const deputy = await createChapterDeputy(chapter, { name: 'Pat Pair' })

    const forLead = await clientAs(lead).admin.volunteers.mergeCandidates({ volunteerId: self.id })
    expect(
      forLead
        .map((c) => [c.id, c.overlap, c.mustKeep, c.gated])
        .sort((x, y) => Number(x[0]) - Number(y[0])),
    ).toEqual(
      [
        [marked.id, ['name', 'email'], null, false],
        [namesake.id, ['name'], null, true],
        [deputy.id, ['name'], 'other', true],
      ].sort((x, y) => Number(x[0]) - Number(y[0])),
    )
    const fromMarked = await clientAs(lead).admin.volunteers.mergeCandidates({
      volunteerId: marked.id,
    })
    expect(fromMarked.find((c) => c.id === self.id)?.keepOther).toBe(true)
    const forAdmin = await clientAs(await createAdmin()).admin.volunteers.mergeCandidates({
      volunteerId: self.id,
    })
    expect(forAdmin.map((c) => c.id)).toContain(elsewhere.id)
    // A deputy merges nothing, and another chapter's lead cannot see the member.
    expect(
      await clientAs(await createChapterDeputy(chapter)).admin.volunteers.mergeCandidates({
        volunteerId: self.id,
      }),
    ).toEqual([])
    await expect(
      clientAs(await createChapterLead(other)).admin.volunteers.mergeCandidates({
        volunteerId: self.id,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('leaves out pairs a lead cannot see through, and never a global admin for a lead', async () => {
    const chapter = await createChapter()
    const lead = await createChapterLead(chapter, { name: 'Sole Name' })
    const member = await createMember(chapter, { name: 'Sole Name' })
    const unconfirmed = await createMember(chapter, { name: 'Sole Name', emailConfirmed: false })
    const admin = await createAdmin({
      name: 'Sole Name',
      nationalChapterId: chapter.id,
      country: chapter.country,
    })
    const forLead = await clientAs(lead).admin.volunteers.mergeCandidates({
      volunteerId: member.id,
    })
    expect(forLead.map((c) => c.id)).not.toContain(unconfirmed.id)
    expect(forLead.map((c) => c.id)).not.toContain(admin.id)
    expect(forLead.map((c) => c.id)).not.toContain(lead.id)
    // Nor a global admin's own account, from their profile.
    expect(
      await clientAs(lead).admin.volunteers.mergeCandidates({ volunteerId: admin.id }),
    ).toEqual([])
    expect((await clientAs(lead).volunteers.getById({ id: admin.id })).manage?.merge).toBeNull()
  })

  it('finds another address for the same Gmail mailbox, whatever the name on it', async () => {
    const chapter = await createChapter()
    const lead = await createChapterLead(chapter)
    const self = await createMember(chapter, { name: 'Ann Gee', email: 'ann.gee@gmail.com' })
    const alias = await createMember(chapter, { name: 'AG', email: 'anngee+old@googlemail.com' })
    await createMember(chapter, { name: 'Other', email: 'anngee@example.org' })
    expect(await clientAs(lead).admin.volunteers.mergeCandidates({ volunteerId: self.id })).toEqual(
      [expect.objectContaining({ id: alias.id, overlap: ['email'], gated: false })],
    )
  })

  it('leaves out a look-alike when both hold a role', async () => {
    const chapter = await createChapter()
    const deputy = await createChapterDeputy(chapter, { name: 'Two Roles' })
    const coordinator = await createCoordinator(chapter, { name: 'Two Roles' })
    const forAdmin = await clientAs(await createAdmin()).admin.volunteers.mergeCandidates({
      volunteerId: deputy.id,
    })
    expect(forAdmin.map((c) => c.id)).not.toContain(coordinator.id)
  })
})

describe('merging accounts that need proof', () => {
  const ask = (who: Parameters<typeof clientAs>[0], keptId: number, mergedId: number) =>
    clientAs(who).admin.volunteers.merge({ keptId, mergedId })

  it('asks each address to confirm, and merges once both have', async () => {
    const chapter = await createChapter()
    const kept = await createMember(chapter, { name: 'Lee Same', email: 'lee.one@example.org' })
    const merged = await createMember(chapter, { name: 'Lee Same', email: 'lee.two@example.org' })
    const admin = await createAdmin()

    expect(await ask(admin, kept.id, merged.id)).toEqual({
      message: 'Sent Lee Same a link at each address; they merge once both are followed',
    })
    const links = ['lee.one@example.org', 'lee.two@example.org'].map((to) => {
      const sent = emails.lastTo(to)
      expect(sent?.subject).toBe(subjects.confirmMerge)
      return linkParam(sent!, 'token')
    })
    // One waiting merge per account.
    await expect(ask(admin, kept.id, merged.id)).rejects.toMatchObject({
      message: 'Lee Same already has a merge waiting for an answer',
    })
    const pending = (await clientAs(admin).volunteers.getById({ id: kept.id })).manage?.merge
    expect(pending).toMatchObject({
      pending: { gate: 'MAILBOXES', canApprove: false, canWithdraw: true },
    })

    expect(await anon().accountMerges.confirmStaff({ token: links[0] })).toMatchObject({
      merged: false,
    })
    // The same link again changes nothing.
    expect(await anon().accountMerges.confirmStaff({ token: links[0] })).toMatchObject({
      merged: false,
    })
    expect(await anon().accountMerges.confirmStaff({ token: links[1] })).toMatchObject({
      merged: true,
    })
    expect(await prisma.volunteer.findUnique({ where: { id: merged.id } })).toMatchObject({
      mergedIntoId: kept.id,
    })
    expect(
      await prisma.chapterAuditEvent.findFirst({
        where: { action: 'ACCOUNT_MERGED', targetVolunteerId: kept.id },
      }),
    ).toMatchObject({ actorId: admin.id, details: { mergedId: merged.id, gate: 'MAILBOXES' } })
    await expect(anon().accountMerges.confirmStaff({ token: links[1] })).rejects.toMatchObject({
      message: 'This link has expired or was already used',
    })
  })

  it('needs a second global admin where an address is unconfirmed, and can be withdrawn', async () => {
    const chapter = await createChapter()
    const kept = await createMember(chapter, { name: 'Ray Same' })
    const merged = await createMember(chapter, { name: 'Ray Same', emailConfirmed: false })
    const [first, second] = [await createAdmin(), await createAdmin()]

    expect(await ask(first, kept.id, merged.id)).toEqual({
      message: 'Another global admin needs to approve this merge',
    })
    const request = await prisma.staffMergeRequest.findFirstOrThrow({
      where: { keptId: kept.id },
    })
    expect(request).toMatchObject({ gate: 'SECOND_ADMIN', keptToken: null })
    await expect(
      clientAs(first).admin.volunteers.approveMerge({ id: request.id }),
    ).rejects.toMatchObject({ message: 'Another global admin must approve it' })
    expect(
      (await clientAs(second).volunteers.getById({ id: merged.id })).manage?.merge?.pending,
    ).toMatchObject({ canApprove: true })
    expect(await clientAs(second).admin.volunteers.approveMerge({ id: request.id })).toEqual({
      message: "Ray Same's account is merged into Ray Same's",
    })
    expect(
      await prisma.chapterAuditEvent.findFirst({
        where: { action: 'ACCOUNT_MERGED', targetVolunteerId: kept.id },
      }),
    ).toMatchObject({
      actorId: second.id,
      details: { gate: 'SECOND_ADMIN', approvedById: second.id },
    })
    // The merge settles the request with the account it closed; the audit row keeps the record.
    await expect(
      clientAs(second).admin.volunteers.approveMerge({ id: request.id }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
    // One still open but expired is refused.
    const c = await createMember(chapter, { name: 'Ida Same' })
    const d = await createMember(chapter, { name: 'Ida Same', emailConfirmed: false })
    await ask(first, c.id, d.id)
    const lapsed = await prisma.staffMergeRequest.findFirstOrThrow({ where: { keptId: c.id } })
    await prisma.staffMergeRequest.update({
      where: { id: lapsed.id },
      data: { expiresAt: new Date(0) },
    })
    await expect(
      clientAs(second).admin.volunteers.approveMerge({ id: lapsed.id }),
    ).rejects.toMatchObject({ message: 'This request has expired or was answered' })

    // A request may be withdrawn while it waits, and its links then do nothing.
    const a = await createMember(chapter, { name: 'Wyn Same' })
    const b = await createMember(chapter, { name: 'Wyn Same' })
    await ask(first, a.id, b.id)
    const waiting = await prisma.staffMergeRequest.findFirstOrThrow({ where: { keptId: a.id } })
    expect(await clientAs(second).admin.volunteers.withdrawMerge({ id: waiting.id })).toEqual({
      message: 'Merge request withdrawn',
    })
    await expect(
      clientAs(second).admin.volunteers.withdrawMerge({ id: waiting.id }),
    ).rejects.toMatchObject({ message: 'This request was already answered' })
    await expect(
      anon().accountMerges.confirmStaff({ token: waiting.keptToken as string }),
    ).rejects.toMatchObject({ message: 'This link has expired or was already used' })
    await expect(
      clientAs(second).admin.volunteers.approveMerge({ id: 999_999 }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it("lets a lead ask a member's two addresses, and lets an expired request be asked again", async () => {
    const chapter = await createChapter()
    const lead = await createChapterLead(chapter)
    const a = await createMember(chapter, { name: 'Gus Same' })
    const b = await createMember(chapter, { name: 'Gus Same' })
    expect(await ask(lead, a.id, b.id)).toEqual({
      message: 'Sent Gus Same a link at each address; they merge once both are followed',
    })
    expect(await clientAs(lead).admin.volunteers.mergeCandidates({ volunteerId: a.id })).toEqual([
      expect.objectContaining({ id: b.id, gated: true, overlap: ['name'] }),
    ])
    await prisma.staffMergeRequest.updateMany({
      where: { keptId: a.id },
      data: { expiresAt: new Date(0) },
    })
    const old = await prisma.staffMergeRequest.findFirstOrThrow({ where: { keptId: a.id } })
    await expect(
      anon().accountMerges.confirmStaff({ token: old.keptToken as string }),
    ).rejects.toMatchObject({ message: 'This link has expired or was already used' })
    expect(await ask(await createAdmin(), a.id, b.id)).toMatchObject({
      message: expect.stringContaining('Sent Gus Same a link'),
    })
    rateLimit.denyNext()
    await expect(anon().accountMerges.confirmStaff({ token: 'x' })).rejects.toMatchObject({
      code: 'TOO_MANY_REQUESTS',
    })
  })
})

describe('admin.volunteers.signOutEverywhere', () => {
  const signedIn = async (token: string) => Boolean(await getCurrentVolunteer(`Bearer ${token}`))

  it("ends every session of a member for their chapter's staff, and logs it", async () => {
    const chapter = await createChapter()
    const lead = await createChapterLead(chapter)
    const member = await createMember(chapter, { name: 'Taken Over' })
    const [phone, laptop] = [await createSession(member.id), await createSession(member.id)]
    // An expired session is cleared but not counted.
    await prisma.session.create({
      data: { volunteerId: member.id, tokenHash: `old-${member.id}`, expiresAt: new Date(0) },
    })
    const { token: apiToken } = await createApiToken(member.id, {
      name: 'script',
      scopes: [],
      expiresAt: null,
    })

    expect(
      await clientAs(lead).admin.volunteers.signOutEverywhere({ volunteerId: member.id }),
    ).toEqual({ message: 'Taken Over is signed out everywhere and their API token is revoked' })
    expect(await signedIn(phone)).toBe(false)
    expect(await signedIn(laptop)).toBe(false)
    expect(await authenticateApiToken(`Bearer ${apiToken}`)).toBeNull()
    expect(await prisma.session.count({ where: { volunteerId: member.id } })).toBe(0)
    const notice = emails.lastTo(member.email as string)
    expect(notice?.subject).toBe('You were signed out of Action Hub on every device')
    expect(notice?.html).toContain('please change your password')
    expect(notice?.html).not.toContain(lead.name)
    expect(
      await prisma.chapterAuditEvent.findFirst({
        where: { action: 'SESSIONS_REVOKED', targetVolunteerId: member.id },
      }),
    ).toMatchObject({
      actorId: lead.id,
      nationalChapterId: chapter.id,
      details: { sessions: 2, apiTokens: 1 },
    })

    // A deputy may too; with nothing to end, nothing is logged and nobody is emailed.
    const sent = emails.sent.length
    expect(
      await clientAs(await createChapterDeputy(chapter)).admin.volunteers.signOutEverywhere({
        volunteerId: member.id,
      }),
    ).toEqual({ message: 'Taken Over was not signed in anywhere' })
    expect(emails.sent.length).toBe(sent)
    expect(
      await prisma.chapterAuditEvent.count({
        where: { action: 'SESSIONS_REVOKED', targetVolunteerId: member.id },
      }),
    ).toBe(1)

    // Signing the same person out over and over is held back.
    await createSession(member.id)
    rateLimit.denyNext()
    await expect(
      clientAs(lead).admin.volunteers.signOutEverywhere({ volunteerId: member.id }),
    ).rejects.toMatchObject({ code: 'TOO_MANY_REQUESTS' })
    expect(await prisma.session.count({ where: { volunteerId: member.id } })).toBe(1)
  })

  it('names every API token it revokes, and treats ADMIN_EMAILS as who outranks whom', async () => {
    const chapter = await createChapter()
    const lead = await createChapterLead(chapter)
    const member = await createMember(chapter, { name: 'Two Scripts' })
    for (const name of ['a', 'b']) {
      await createApiToken(member.id, { name, scopes: [], expiresAt: null })
    }
    expect(
      await clientAs(lead).admin.volunteers.signOutEverywhere({ volunteerId: member.id }),
    ).toEqual({
      message: 'Two Scripts is signed out everywhere and their 2 API tokens are revoked',
    })
    // Listed in ADMIN_EMAILS but not yet marked isAdmin: still a global admin.
    const unmarked = await createAdmin({
      nationalChapterId: chapter.id,
      country: chapter.country,
      isAdmin: false,
    })
    await expect(
      clientAs(lead).admin.volunteers.signOutEverywhere({ volunteerId: unmarked.id }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })

  it('is refused to everyone else', async () => {
    const chapter = await createChapter()
    const member = await createMember(chapter)
    const token = await createSession(member.id)
    const attempt = (viewer: Parameters<typeof clientAs>[0], id = member.id) =>
      clientAs(viewer).admin.volunteers.signOutEverywhere({ volunteerId: id })

    await expect(attempt(await createMember(chapter))).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(attempt(await createCoordinator(chapter))).rejects.toMatchObject({
      code: 'FORBIDDEN',
    })
    await expect(attempt(await createChapterLead(await createChapter()))).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
    const admin = await createAdmin({ nationalChapterId: chapter.id, country: chapter.country })
    await expect(
      clientAs(withoutAdminRights(admin), {
        viewingAsVolunteer: true,
      }).admin.volunteers.signOutEverywhere({ volunteerId: member.id }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    const lead = await createChapterLead(chapter)
    await expect(attempt(lead, lead.id)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'Sign yourself out of other devices from your settings',
    })
    const gone = await createMember(chapter, { deletedAt: new Date() })
    await expect(attempt(lead, gone.id)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    // A deputy cannot sign out their lead, nor chapter staff a global admin in their chapter.
    const deputy = await createChapterDeputy(chapter)
    await expect(attempt(deputy, lead.id)).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: `Only a global admin can sign ${lead.name} out`,
    })
    await expect(attempt(lead, admin.id)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(await signedIn(token)).toBe(true)

    // A global admin may for anyone, another global admin and the holding pool included.
    expect(await attempt(await createAdmin(), admin.id)).toMatchObject({
      message: expect.stringContaining('was not signed in anywhere'),
    })
    expect(await attempt(await createAdmin(), lead.id)).toBeDefined()
    const pooled = await createVolunteer()
    await createSession(pooled.id)
    expect(await attempt(await createAdmin(), pooled.id)).toMatchObject({
      message: expect.stringContaining('signed out everywhere'),
    })
  })
})

describe('admin.volunteers.setSuspended', () => {
  const suspend = (
    who: Parameters<typeof clientAs>[0],
    volunteerId: number,
    reason = 'Abusive messages',
  ) => clientAs(who).admin.volunteers.setSuspended({ volunteerId, suspended: true, reason })

  it('signs a member out, keeps them out, and hides them, until it is lifted', async () => {
    const chapter = await createChapter()
    const lead = await createChapterLead(chapter, { name: 'Suspending Lead' })
    const deputy = await createChapterDeputy(chapter)
    const admin = await createAdmin()
    const member = await createMember(chapter, {
      name: 'Paused Person',
      consentMakeProfileVisibleInDirectory: true,
    })
    const token = await createSession(member.id)
    const { token: apiToken } = await createApiToken(member.id, {
      name: 'a',
      scopes: [],
      expiresAt: null,
    })

    expect(await suspend(lead, member.id)).toEqual({ message: 'Paused Person is suspended' })
    expect(await getCurrentVolunteer(`Bearer ${token}`)).toBeNull()
    expect(await authenticateApiToken(`Bearer ${apiToken}`)).toBeNull()
    await expect(
      anon().auth.login({ email: member.email as string, password: TEST_PASSWORD }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN', message: SUSPENDED_MESSAGE })
    expect(
      await prisma.chapterAuditEvent.findFirst({
        where: { action: 'MEMBER_SUSPENDED', targetVolunteerId: member.id },
      }),
    ).toMatchObject({ actorId: lead.id, details: { reason: 'Abusive messages' } })

    // Told kindly, never why; staff and global admins are told, the lead is not told of their own act.
    const notice = emails.lastTo(member.email as string)
    expect(notice?.subject).toBe(subjects.suspended)
    expect(notice?.html).not.toContain('Abusive')
    const told = await prisma.notification.findMany({
      where: { type: 'member_suspended' },
      select: { volunteerId: true, title: true, body: true },
    })
    expect(told.map((n) => n.volunteerId)).toEqual(expect.arrayContaining([deputy.id, admin.id]))
    expect(told.map((n) => n.volunteerId)).not.toContain(lead.id)
    expect(told[0]).toMatchObject({
      title: 'Suspending Lead suspended Paused Person',
      body: 'Abusive messages',
    })

    // Out of sight to other members and the directory; still there for its staff.
    const fellow = await createMember(chapter)
    await expect(clientAs(fellow).volunteers.getById({ id: member.id })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
    const listed = await clientAs(fellow).volunteers.list({})
    expect(listed.volunteers.map((v) => v.id)).not.toContain(member.id)
    // Nor in any list or picker, staff's included; the chapter's own page marks them.
    const forStaff = await clientAs(deputy).volunteers.list({})
    expect(forStaff.volunteers.map((v) => v.id)).not.toContain(member.id)
    const page = await clientAs(deputy).admin.chapters.get({ chapterId: chapter.id })
    expect(page.members.find((m) => m.id === member.id)?.suspendedAt).toEqual(expect.any(Date))
    expect((await clientAs(deputy).volunteers.getById({ id: member.id })).manage?.suspend).toEqual({
      suspension: {
        at: expect.any(Date),
        byName: 'Suspending Lead',
        reason: 'Abusive messages',
      },
    })

    expect(
      await clientAs(deputy).admin.volunteers.setSuspended({
        volunteerId: member.id,
        suspended: false,
      }),
    ).toEqual({ message: 'Paused Person is no longer suspended' })
    expect(emails.lastTo(member.email as string)?.subject).toBe(subjects.lifted)
    expect(
      (await anon().auth.login({ email: member.email as string, password: TEST_PASSWORD })).token,
    ).toBeTruthy()
  })

  it('suspends nobody who still holds a role, and refuses what makes no sense', async () => {
    const chapter = await createChapter()
    const lead = await createChapterLead(chapter)
    const deputy = await createChapterDeputy(chapter)
    const coordinator = await createCoordinator(chapter)
    const member = await createMember(chapter)
    const admin = await createAdmin({ nationalChapterId: chapter.id, country: chapter.country })

    // Not even a global admin suspends a lead, deputy or coordinator who keeps the role.
    for (const who of [deputy, coordinator]) {
      await expect(suspend(lead, who.id)).rejects.toMatchObject({ code: 'FORBIDDEN' })
      await expect(suspend(await createAdmin(), who.id)).rejects.toMatchObject({
        message: expect.stringContaining('Take the role away before suspending them.'),
      })
    }
    await expect(suspend(deputy, lead.id)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(suspend(lead, admin.id)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(suspend(await createAdmin(), admin.id)).rejects.toMatchObject({
      message: 'A global admin cannot be suspended here',
    })
    await expect(suspend(lead, lead.id)).rejects.toMatchObject({
      message: 'You cannot suspend yourself',
    })
    await expect(suspend(lead, member.id, 'x')).rejects.toMatchObject({
      message: 'Say why, for the record',
    })
    await expect(
      clientAs(lead).admin.volunteers.setSuspended({ volunteerId: member.id, suspended: false }),
    ).rejects.toMatchObject({ message: expect.stringContaining('is not suspended') })
    await suspend(lead, member.id)
    await expect(suspend(lead, member.id)).rejects.toMatchObject({
      message: expect.stringContaining('is already suspended'),
    })
    await expect(
      suspend(await createChapterLead(await createChapter()), member.id),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(suspend(await createMember(chapter), member.id)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    })
  })

  it('holds back on repeats, and stands when the email fails or must not be sent', async () => {
    const chapter = await createChapter()
    const lead = await createChapterLead(chapter)
    const member = await createMember(chapter, { name: 'Unlucky' })
    emails.failNext()
    expect(await suspend(lead, member.id)).toEqual({ message: 'Unlucky is suspended' })
    expect(await prisma.volunteer.findUniqueOrThrow({ where: { id: member.id } })).toMatchObject({
      suspendedAt: expect.any(Date),
    })
    rateLimit.denyNext()
    await expect(
      clientAs(lead).admin.volunteers.setSuspended({ volunteerId: member.id, suspended: false }),
    ).rejects.toMatchObject({ code: 'TOO_MANY_REQUESTS' })

    // An address they never confirmed may not be theirs, so it is not told.
    const unconfirmed = await createMember(chapter, { emailConfirmed: false })
    const sent = emails.sent.length
    await suspend(lead, unconfirmed.id)
    expect(emails.sent.length).toBe(sent)
  })

  it('keeps a suspended member off any new work, even where they already are', async () => {
    const chapter = await createChapter()
    const lead = await createChapterLead(chapter)
    const member = await createMember(chapter, { name: 'Benched' })
    const project = await createProject({ nationalChapterId: chapter.id, status: 'in_progress' })
    const owned = await createProject({
      nationalChapterId: chapter.id,
      status: 'in_progress',
      assigneeId: lead.id,
    })
    await prisma.workItemInterest.create({
      data: {
        workItemId: owned.id,
        volunteerId: member.id,
        status: 'accepted',
        interestType: 'want_to_contribute',
      },
    })
    const task = await createTask(owned.id)
    await suspend(lead, member.id)
    const isSuspended = { code: 'BAD_REQUEST', message: 'Benched is suspended' }
    // Nor any role: chapter deputy or lead, project deputy, team leader or new team member.
    await expect(
      clientAs(lead).admin.chapters.appointDeputy({
        chapterId: chapter.id,
        volunteerId: member.id,
      }),
    ).rejects.toMatchObject(isSuspended)
    await expect(
      clientAs(await createAdmin()).admin.chapters.appointLead({
        chapterId: chapter.id,
        volunteerId: member.id,
      }),
    ).rejects.toMatchObject(isSuspended)
    await expect(
      clientAs(lead).projects.appointDeputy({ projectId: owned.id, volunteerId: member.id }),
    ).rejects.toMatchObject(isSuspended)
    const team = await prisma.team.create({
      data: { name: 'Bench team', nationalChapterId: chapter.id },
    })
    await prisma.teamMembership.create({
      data: { teamId: team.id, volunteerId: member.id, role: 'member' },
    })
    await expect(
      clientAs(lead).teams.setMemberRole({
        teamId: team.id,
        volunteerId: member.id,
        role: 'leader',
      }),
    ).rejects.toMatchObject(isSuspended)
    const otherTeam = await prisma.team.create({
      data: { name: 'Bench team two', nationalChapterId: chapter.id },
    })
    const ask = await prisma.teamJoinRequest.create({
      data: { teamId: otherTeam.id, volunteerId: member.id },
    })
    await expect(
      clientAs(lead).teams.reviewJoinRequest({ id: ask.id, action: 'accept' }),
    ).rejects.toMatchObject(isSuspended)
    // While suspended, the profile offers no role to give them.
    expect(
      (await clientAs(await createAdmin()).volunteers.getById({ id: member.id })).manage,
    ).toMatchObject({
      chapterDeputy: null,
      chapterLead: null,
      coordinator: null,
    })
    await expect(
      clientAs(lead).projects.updateTask({
        projectId: owned.id,
        taskId: task.id,
        data: { assigneeId: member.id },
      }),
    ).rejects.toMatchObject(isSuspended)
    await expect(
      clientAs(lead).projects.invite({ projectId: project.id, volunteerId: member.id }),
    ).rejects.toMatchObject(isSuspended)
    await expect(
      clientAs(lead).projects.assign({ projectId: project.id, volunteerId: member.id }),
    ).rejects.toMatchObject(isSuspended)
  })
})

describe('admin.volunteers.history', () => {
  it("lists what was done to a member, newest first, for their chapter's staff", async () => {
    const chapter = await createChapter()
    const lead = await createChapterLead(chapter, { name: 'Hist Lead' })
    const member = await createMember(chapter)
    await clientAs(lead).admin.chapters.appointDeputy({
      chapterId: chapter.id,
      volunteerId: member.id,
    })
    await clientAs(lead).admin.chapters.removeDeputy({
      chapterId: chapter.id,
      volunteerId: member.id,
    })
    // Something another chapter's staff did before the member moved here stays theirs.
    await prisma.chapterAuditEvent.create({
      data: {
        action: 'PROFILE_PICTURE_REMOVED',
        nationalChapterId: (await createChapter()).id,
        targetVolunteerId: member.id,
      },
    })
    const { events, more } = await clientAs(
      await createChapterDeputy(chapter),
    ).admin.volunteers.history({ volunteerId: member.id })
    expect(events.map((e) => [e.action, e.actor?.name, e.chapterName])).toEqual([
      ['DEPUTY_REMOVED', 'Hist Lead', chapter.name],
      ['DEPUTY_APPOINTED', 'Hist Lead', chapter.name],
    ])
    expect(more).toBe(false)
    // A global admin sees all of it.
    const all = await clientAs(await createAdmin()).admin.volunteers.history({
      volunteerId: member.id,
    })
    expect(all.events.map((e) => e.action)).toContain('PROFILE_PICTURE_REMOVED')

    await expect(
      clientAs(await createChapterLead(await createChapter())).admin.volunteers.history({
        volunteerId: member.id,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(
      clientAs(await createMember(chapter)).admin.volunteers.history({ volunteerId: member.id }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })

  it('says when older entries are cut, and does not link an actor whose account is gone', async () => {
    const chapter = await createChapter()
    const member = await createMember(chapter)
    const gone = await createMember(chapter, { name: 'Former Lead', deletedAt: new Date() })
    await prisma.chapterAuditEvent.createMany({
      data: Array.from({ length: 101 }, () => ({
        action: 'DEPUTY_APPOINTED' as const,
        actorId: gone.id,
        nationalChapterId: chapter.id,
        targetVolunteerId: member.id,
      })),
    })
    const { events, more } = await clientAs(await createAdmin()).admin.volunteers.history({
      volunteerId: member.id,
    })
    expect(events).toHaveLength(100)
    expect(more).toBe(true)
    expect(events[0].actor).toEqual({ id: null, name: 'Former Lead' })
  })

  it("refuses a deleted member's endorsements as well as their history", async () => {
    const chapter = await createChapter()
    const gone = await createMember(chapter, { deletedAt: new Date() })
    const lead = clientAs(await createChapterLead(chapter))
    await expect(
      lead.admin.volunteers.listEndorsements({ volunteerId: gone.id }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(lead.admin.volunteers.history({ volunteerId: gone.id })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
  })
})

describe('admin.volunteers.projectsToOffer', () => {
  it("lists the live projects of the member's chapter they are not on, saying where they stand", async () => {
    const chapter = await createChapter()
    const lead = await createChapterLead(chapter)
    const member = await createMember(chapter)
    const at = { nationalChapterId: chapter.id }
    const open = await createProject({ ...at, title: 'A open', status: 'in_progress' })
    const applied = await createProject({ ...at, title: 'B applied', status: 'ready' })
    const invited = await createProject({ ...at, title: 'C invited', status: 'on_hold' })
    const on = await createProject({ ...at, title: 'D on it' })
    await createProject({ ...at, title: 'E owned', assigneeId: member.id })
    await createProject({ ...at, title: 'F draft', status: 'draft' })
    await createProject({ ...at, title: 'G done', status: 'completed' })
    await createProject({ title: 'H elsewhere', nationalChapterId: (await createChapter()).id })
    const interest = (workItemId: number, status: 'pending' | 'invited' | 'accepted') =>
      prisma.workItemInterest.create({
        data: { workItemId, volunteerId: member.id, status, interestType: 'want_to_contribute' },
      })
    await interest(applied.id, 'pending')
    await interest(invited.id, 'invited')
    await interest(on.id, 'accepted')
    const toOwn = await createProject({ ...at, title: 'I asked to own' })
    await prisma.workItemInterest.create({
      data: {
        workItemId: toOwn.id,
        volunteerId: member.id,
        status: 'pending',
        interestType: 'want_to_own',
      },
    })

    expect(
      await clientAs(lead).admin.volunteers.projectsToOffer({ volunteerId: member.id }),
    ).toEqual([
      { id: open.id, title: 'A open', standing: null },
      { id: applied.id, title: 'B applied', standing: 'applied' },
      { id: invited.id, title: 'C invited', standing: 'invited' },
    ])
  })

  it("offers a pool member the pool's projects, and only to whoever runs them", async () => {
    const pooled = await createVolunteer()
    const poolProject = await createProject({ title: 'Pool work', nationalChapterId: null })
    await createProject({ title: 'Chapter work', nationalChapterId: (await createChapter()).id })
    const offered = await clientAs(await createAdmin()).admin.volunteers.projectsToOffer({
      volunteerId: pooled.id,
    })
    expect(offered.map((p) => p.id)).toContain(poolProject.id)
    expect(offered.map((p) => p.title)).not.toContain('Chapter work')

    const chapter = await createChapter()
    const member = await createMember(chapter)
    await expect(
      clientAs(await createChapterLead(await createChapter())).admin.volunteers.projectsToOffer({
        volunteerId: member.id,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(
      clientAs(await createMember(chapter)).admin.volunteers.projectsToOffer({
        volunteerId: member.id,
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    // Nor for a deleted account, nor may skills be endorsed on one.
    const gone = await createMember(chapter, { deletedAt: new Date() })
    const lead = clientAs(await createChapterLead(chapter))
    await expect(
      lead.admin.volunteers.projectsToOffer({ volunteerId: gone.id }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(
      lead.admin.volunteers.addEndorsement({
        volunteerId: gone.id,
        skillId: (await createSkill()).id,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})
