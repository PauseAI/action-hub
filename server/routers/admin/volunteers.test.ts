import { describe, it, expect } from 'vitest'
import { prisma } from '@/lib/prisma'
import {
  createVolunteer,
  createAdmin,
  createProject,
  createQuickTask,
  createSkill,
  createChapter,
  createChapterDeputy,
  createChapterLead,
  createMember,
  createCoordinator,
} from '@/test/factories'
import { clientAs } from '@/test/rpc'
import { createSession, getCurrentVolunteer } from '@/lib/auth'
import { authenticateApiToken, createApiToken } from '@/lib/api-tokens'
import { emails } from '@/test/fakes/email'
import { rateLimit } from '@/test/fakes/rate-limit'
import { withoutAdminRights } from '@/lib/view-as'

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
