import { describe, it, expect, vi } from 'vitest'
import { prisma } from '@/lib/prisma'
import {
  createAdmin,
  createChapter,
  createChapterDeputy,
  createChapterLead,
  createMember,
  createProject,
  createTask,
  createVolunteer,
} from '@/test/factories'
import { clientAs } from '@/test/rpc'
import { suggestFastTrack } from '@/lib/fast-track'

const SUGGESTED = 'fast_track_suggested'

const notes = (volunteerId: number, type: string) =>
  prisma.notification.findMany({ where: { volunteerId, type }, orderBy: { id: 'asc' } })
const noted = (volunteerId: number, type: string, count = 1) =>
  vi.waitFor(async () => {
    const rows = await notes(volunteerId, type)
    expect(rows).toHaveLength(count)
    return rows
  })
const membership = (volunteerId: number, workItemId: number) =>
  prisma.workItemInterest.findUnique({
    where: { volunteerId_workItemId: { volunteerId, workItemId } },
  })

/** A chapter with a lead and a deputy, and a running project in it owned by Olive. */
async function chapterWithProject(projectOverrides = {}) {
  const chapter = await createChapter()
  const lead = await createChapterLead(chapter)
  const deputy = await createChapterDeputy(chapter)
  const owner = await createMember(chapter, { name: 'Olive Owner' })
  const project = await createProject({
    assigneeId: owner.id,
    status: 'in_progress',
    nationalChapterId: chapter.id,
    ...projectOverrides,
  })
  return { chapter, lead, deputy, owner, project }
}

describe('putting someone on fast track', () => {
  it("is done by their chapter's lead or deputies, or a global admin, and seen by few", async () => {
    const { chapter, lead, deputy } = await chapterWithProject()
    const sam = await createMember(chapter, { name: 'Sam' })
    const member = await createMember(chapter)
    const elsewhere = await chapterWithProject()
    const set = (who: { id: number }, on: boolean) =>
      clientAs(who as never).volunteers.setFastTrack({ volunteerId: sam.id, on })

    expect(await set(lead, true)).toEqual({ message: 'On fast track' })
    expect(await prisma.volunteer.findUniqueOrThrow({ where: { id: sam.id } })).toMatchObject({
      fastTrack: true,
      fastTrackSetById: lead.id,
    })
    expect(await set(deputy, false)).toEqual({ message: 'Off fast track' })
    expect(await set(await createAdmin(), true)).toEqual({ message: 'On fast track' })
    for (const who of [member, elsewhere.lead]) {
      await expect(set(who, false)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    }
    await expect(
      clientAs(sam).volunteers.setFastTrack({ volunteerId: sam.id, on: false }),
    ).rejects.toMatchObject({ message: 'Someone else decides your fast track' })

    // Shown to Sam and his chapter's staff, never to other volunteers.
    const profile = (who: { id: number }) =>
      clientAs(who as never).volunteers.getById({ id: sam.id })
    expect((await profile(sam)).fastTrack).toEqual({ on: true, canSet: false })
    expect((await profile(lead)).fastTrack).toEqual({ on: true, canSet: true })
    expect((await profile(member)).fastTrack).toBeNull()
  })

  it('is set for someone with no chapter by a global admin only', async () => {
    const pooled = await createVolunteer()
    const { lead } = await chapterWithProject()
    await expect(
      clientAs(lead).volunteers.setFastTrack({ volunteerId: pooled.id, on: true }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await clientAs(await createAdmin()).volunteers.setFastTrack({
      volunteerId: pooled.id,
      on: true,
    })
    expect((await prisma.volunteer.findUniqueOrThrow({ where: { id: pooled.id } })).fastTrack).toBe(
      true,
    )
  })
})

describe('a volunteer on fast track', () => {
  it('takes a task and a helper place straight away, joining the project, and the owner is told', async () => {
    const { chapter, deputy, owner, project } = await chapterWithProject({ title: 'Briefing' })
    await prisma.workItemInterest.create({
      data: {
        workItemId: project.id,
        volunteerId: deputy.id,
        interestType: 'want_to_contribute',
        status: 'accepted',
      },
    })
    await prisma.projectDeputy.create({ data: { projectId: project.id, volunteerId: deputy.id } })
    const sam = await createMember(chapter, { name: 'Sam', fastTrack: true })
    const lead = await createTask(project.id, { title: 'Book a room' })
    const help = await createTask(project.id, { title: 'Practise', helpersWanted: 1 })

    expect(
      await clientAs(sam).projects.updateTask({
        projectId: project.id,
        taskId: lead.id,
        data: { assigneeId: sam.id },
      }),
    ).toMatchObject({ requested: false })
    expect((await prisma.workItem.findUniqueOrThrow({ where: { id: lead.id } })).assigneeId).toBe(
      sam.id,
    )
    expect(await membership(sam.id, project.id)).toMatchObject({
      status: 'accepted',
      origin: 'applied',
    })
    for (const to of [owner, deputy]) {
      expect((await noted(to.id, 'fast_track_started'))[0].title).toBe(
        "Sam (fast track) has started on 'Book a room'",
      )
    }
    expect(await notes(owner.id, 'new_interest')).toHaveLength(0)
    // The task page offers to claim it, not to ask.
    expect(
      (await clientAs(sam).projects.getTask({ projectId: project.id, taskId: help.id }))
        .claimViewer,
    ).toEqual({ onProject: true, invited: false })

    // A second project in the chapter: offering to help takes the place at once.
    const otherOwner = await createMember(chapter)
    const other = {
      owner: otherOwner,
      project: await createProject({
        assigneeId: otherOwner.id,
        status: 'in_progress',
        nationalChapterId: chapter.id,
      }),
    }
    const place = await createTask(other.project.id, { title: 'Stall', helpersWanted: 1 })
    expect(
      await clientAs(sam).projects.expressInterest({
        projectId: other.project.id,
        taskId: place.id,
        interestType: 'want_to_help_task',
      }),
    ).toMatchObject({ requested: false })
    expect((await membership(sam.id, place.id))?.status).toBe('accepted')
    expect((await membership(sam.id, other.project.id))?.status).toBe('accepted')
    expect((await noted(other.owner.id, 'fast_track_started'))[0].title).toBe(
      "Sam (fast track) has started on 'Stall'",
    )
    // The owner hears it once, not again as the lead of a task nobody leads.
    expect(await notes(other.owner.id, 'task_helpers_changed')).toHaveLength(0)
    // Already a member, joining another task is the usual join.
    await clientAs(sam).projects.expressInterest({
      projectId: project.id,
      taskId: help.id,
      interestType: 'want_to_help_task',
    })
    expect(await notes(owner.id, 'fast_track_started')).toHaveLength(1)
  })

  it('sees Claim and Join as helper where they will start at once, and asks elsewhere', async () => {
    const { chapter, project } = await chapterWithProject()
    const sam = await createMember(chapter, { fastTrack: true })
    const task = await createTask(project.id)
    const seen = () => clientAs(sam).projects.getTask({ projectId: project.id, taskId: task.id })
    expect((await seen()).claimViewer).toEqual({
      onProject: false,
      invited: false,
      fastTrack: true,
    })
    await prisma.workItem.update({ where: { id: project.id }, data: { alwaysAskToJoin: true } })
    expect((await seen()).claimViewer).toEqual({ onProject: false, invited: false })
  })

  it('keeps an offer to lead waiting rather than joining past it', async () => {
    const { chapter, owner, project } = await chapterWithProject()
    const sam = await createMember(chapter, { fastTrack: true })
    await prisma.workItemInterest.create({
      data: {
        workItemId: project.id,
        volunteerId: sam.id,
        interestType: 'want_to_own',
        status: 'pending',
      },
    })
    const task = await createTask(project.id, { helpersWanted: 1 })
    expect(
      await clientAs(sam).projects.expressInterest({
        projectId: project.id,
        taskId: task.id,
        interestType: 'want_to_help_task',
      }),
    ).toMatchObject({ requested: true })
    expect(await membership(sam.id, project.id)).toMatchObject({
      status: 'pending',
      interestType: 'want_to_own',
    })
    expect(await notes(owner.id, 'fast_track_started')).toHaveLength(0)
  })

  it('waits like anyone else on a project that always asks, or that turned them down', async () => {
    const { chapter, owner, project } = await chapterWithProject()
    const sam = await createMember(chapter, { fastTrack: true })
    // Only the owner or an admin sets it, not its proposer.
    const proposer = await createMember(chapter)
    await prisma.workItem.update({ where: { id: project.id }, data: { creatorId: proposer.id } })
    await expect(
      clientAs(proposer).projects.update({ id: project.id, alwaysAskToJoin: true }),
    ).rejects.toMatchObject({
      message: 'Only the project owner or an admin can change who waits to join',
    })
    await clientAs(owner).projects.update({ id: project.id, alwaysAskToJoin: true })
    const task = await createTask(project.id, { helpersWanted: 1 })
    expect(
      await clientAs(sam).projects.expressInterest({
        projectId: project.id,
        taskId: task.id,
        interestType: 'want_to_help_task',
      }),
    ).toMatchObject({ requested: true })
    expect((await membership(sam.id, project.id))?.status).toBe('pending')

    const other = await chapterWithProject()
    await prisma.workItemInterest.create({
      data: {
        workItemId: other.project.id,
        volunteerId: sam.id,
        interestType: 'want_to_contribute',
        status: 'declined',
      },
    })
    const theirs = await createTask(other.project.id)
    await expect(
      clientAs(sam).projects.updateTask({
        projectId: other.project.id,
        taskId: theirs.id,
        data: { assigneeId: sam.id },
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })
})

describe('asking staff to put someone on fast track', () => {
  /** Sam takes a task on the project and hands it in; the owner accepts it unless it auto-accepts. */
  async function doTask(
    owner: { id: number },
    sam: { id: number },
    projectId: number,
    autoAccepted: boolean,
  ) {
    const task = await createTask(projectId, { assigneeId: sam.id, status: 'in_progress' })
    await prisma.workItem.update({
      where: { id: projectId },
      data: { autoAcceptTasks: autoAccepted },
    })
    await clientAs(sam as never).projects.submitTask({ projectId, taskId: task.id, note: 'Done' })
    if (!autoAccepted) {
      await clientAs(owner as never).projects.acceptTask({ projectId, taskId: task.id })
    }
  }

  it("asks the chapter's lead and deputies after three accepted, and again three after Not now", async () => {
    const { chapter, lead, deputy, owner, project } = await chapterWithProject()
    const sam = await createMember(chapter, { name: 'Sam' })
    await prisma.workItemInterest.create({
      data: {
        workItemId: project.id,
        volunteerId: sam.id,
        interestType: 'want_to_contribute',
        status: 'accepted',
      },
    })
    await doTask(owner, sam, project.id, false)
    await doTask(owner, sam, project.id, true)
    expect(await notes(lead.id, SUGGESTED)).toHaveLength(0)
    await doTask(owner, sam, project.id, false)

    for (const to of [lead, deputy]) {
      const [ask] = await noted(to.id, SUGGESTED)
      expect(ask).toMatchObject({
        title: 'Sam has had 3 tasks submitted and accepted',
        body: 'Put Sam on fast track, so they can start tasks straight away without waiting for approval?',
        link: `/volunteers/${sam.id}`,
        entityId: sam.id,
      })
    }
    const inbox = await clientAs(lead).notifications.list({})
    expect(inbox.notifications.find((n) => n.type === SUGGESTED)?.action).toEqual({
      kind: 'fast_track',
      volunteerId: sam.id,
      name: 'Sam',
    })
    // Someone outside the chapter cannot answer it.
    await expect(
      clientAs((await chapterWithProject()).lead).volunteers.dismissFastTrack({
        volunteerId: sam.id,
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })

    // Not now: the ask goes for everyone, and comes back three tasks later.
    await clientAs(lead).volunteers.dismissFastTrack({ volunteerId: sam.id })
    await vi.waitFor(async () => expect(await notes(deputy.id, SUGGESTED)).toHaveLength(0))
    for (let i = 0; i < 2; i++) await doTask(owner, sam, project.id, true)
    expect(await notes(lead.id, SUGGESTED)).toHaveLength(0)
    await doTask(owner, sam, project.id, true)
    expect((await noted(lead.id, SUGGESTED))[0].title).toBe(
      'Sam has had 6 tasks submitted and accepted',
    )

    // Fast tracked from the ask: it goes, and none come after.
    await clientAs(deputy).volunteers.setFastTrack({ volunteerId: sam.id, on: true })
    await vi.waitFor(async () => expect(await notes(lead.id, SUGGESTED)).toHaveLength(0))
    for (let i = 0; i < 3; i++) await doTask(owner, sam, project.id, true)
    expect(await notes(lead.id, SUGGESTED)).toHaveLength(0)
  })

  it('asks the global admins about someone with no chapter', async () => {
    const admin = await createAdmin()
    const owner = await createVolunteer()
    const project = await createProject({ assigneeId: owner.id, status: 'in_progress' })
    const sam = await createVolunteer({ name: 'Sam' })
    for (let i = 0; i < 3; i++) await doTask(owner, sam, project.id, true)
    expect((await noted(admin.id, SUGGESTED))[0].title).toBe(
      'Sam has had 3 tasks submitted and accepted',
    )
  })

  it('never asks about staff, nor counts quick tasks or work on their own projects', async () => {
    const { chapter, lead, owner, project } = await chapterWithProject()
    const dee = await createChapterDeputy(chapter, { name: 'Dee' })
    for (let i = 0; i < 3; i++) await doTask(owner, dee, project.id, true)
    // The lead hears nothing, and neither does Dee about herself.
    expect(await notes(lead.id, SUGGESTED)).toHaveLength(0)
    expect(await notes(dee.id, SUGGESTED)).toHaveLength(0)

    const sam = await createMember(chapter, { name: 'Sam' })
    const own = await createProject({
      assigneeId: sam.id,
      status: 'in_progress',
      nationalChapterId: chapter.id,
    })
    for (let i = 0; i < 3; i++) await doTask(sam, sam, own.id, true)
    const quick = await prisma.workItem.create({
      data: { type: 'QUICK_TASK', status: 'completed', title: 'Quick', assigneeId: sam.id },
    })
    await prisma.workItemEvent.create({
      data: { workItemId: quick.id, actorId: sam.id, kind: 'submitted', before: {}, after: {} },
    })
    await doTask(owner, sam, project.id, true)
    expect(await notes(lead.id, SUGGESTED)).toHaveLength(0)
  })

  it('waits three more tasks after someone is taken off fast track', async () => {
    const { chapter, lead, owner, project } = await chapterWithProject()
    const sam = await createMember(chapter, { name: 'Sam', fastTrack: true })
    for (let i = 0; i < 4; i++) await doTask(owner, sam, project.id, true)
    await clientAs(lead).volunteers.setFastTrack({ volunteerId: sam.id, on: false })
    expect(
      (await prisma.volunteer.findUniqueOrThrow({ where: { id: sam.id } })).fastTrackNextAskAt,
    ).toBe(7)
    await doTask(owner, sam, project.id, true)
    expect(await notes(lead.id, SUGGESTED)).toHaveLength(0)
  })

  it('asks once when two tasks are accepted at the same moment', async () => {
    const { chapter, lead, owner, project } = await chapterWithProject()
    const sam = await createMember(chapter, { name: 'Sam' })
    for (let i = 0; i < 3; i++) await doTask(owner, sam, project.id, true)
    await prisma.notification.deleteMany({ where: { type: SUGGESTED } })
    await prisma.volunteer.update({ where: { id: sam.id }, data: { fastTrackNextAskAt: 3 } })
    await Promise.all(Array.from({ length: 5 }, () => suggestFastTrack(sam.id)))
    expect(await noted(lead.id, SUGGESTED)).toHaveLength(1)
  })
})
