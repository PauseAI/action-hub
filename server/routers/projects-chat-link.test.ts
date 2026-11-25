import { describe, it, expect } from 'vitest'
import { prisma } from '@/lib/prisma'
import { chapterFor, createAdmin, createProject, createVolunteer } from '@/test/factories'
import { clientAs } from '@/test/rpc'

const CHAT = 'https://discord.com/channels/1/2'

const proposal = {
  title: 'Chatty',
  description: 'desc',
  projectType: 'sprint',
  estimatedDuration: '1 week',
  timeCommitmentHoursPerWeek: 2,
  urgency: 'medium',
  collaborationLink: null,
  isSeekingHelp: true,
}

const chatLinkOf = async (id: number) =>
  (await prisma.workItem.findUniqueOrThrow({ where: { id } })).chatLink

describe('a project chat link', () => {
  it('is saved by either create, an empty one as none', async () => {
    const mine = await clientAs(await createVolunteer()).projects.create({
      ...proposal,
      chatLink: CHAT,
    })
    expect(await chatLinkOf(mine.id)).toBe(CHAT)
    const empty = await clientAs(await createVolunteer()).projects.create({
      ...proposal,
      chatLink: '',
    })
    expect(await chatLinkOf(empty.id)).toBeNull()

    const admin = clientAs(await createAdmin())
    const org = await admin.admin.projects.create({
      ...proposal,
      chatLink: CHAT,
      saveAsDraft: true,
    })
    expect(await chatLinkOf(org.id)).toBe(CHAT)
    const none = await admin.admin.projects.create({ ...proposal, saveAsDraft: true })
    expect(await chatLinkOf(none.id)).toBeNull()
  })

  it('is shown to those with a part in the project, and never in a list', async () => {
    const chapter = await chapterFor('UK')
    const owner = await createVolunteer({ nationalChapterId: chapter.id })
    const helper = await createVolunteer({ nationalChapterId: chapter.id })
    const outsider = await createVolunteer({ nationalChapterId: chapter.id })
    const project = await createProject({
      title: 'Chat project',
      assigneeId: owner.id,
      status: 'in_progress',
      isSeekingHelp: true,
      nationalChapterId: chapter.id,
      chatLink: CHAT,
    })
    await prisma.workItemInterest.create({
      data: {
        workItemId: project.id,
        volunteerId: helper.id,
        interestType: 'want_to_contribute',
        status: 'accepted',
      },
    })
    const seen = async (viewer: Parameters<typeof clientAs>[0]) =>
      (await clientAs(viewer).projects.getById({ id: project.id })).chatLink

    expect(await seen(owner)).toBe(CHAT)
    expect(await seen(helper)).toBe(CHAT)
    expect(await seen(await createAdmin())).toBe(CHAT)
    expect(await seen(outsider)).toBeNull()

    const listed = (await clientAs(owner).projects.list({})).projects.find(
      (p) => p.id === project.id,
    )
    expect(listed).toBeDefined()
    expect(listed).not.toHaveProperty('chatLink')
  })
})
