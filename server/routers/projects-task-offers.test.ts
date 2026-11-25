import { describe, it, expect, vi } from 'vitest'
import { prisma } from '@/lib/prisma'
import {
  createAdmin,
  createChapter,
  createMember,
  createProject,
  createTask,
  createVolunteer,
} from '@/test/factories'
import { clientAs } from '@/test/rpc'
import { PLACE_FILLED } from '@/lib/task-offers'
import { TASK_OFFER_SENT_MESSAGE } from '@/lib/action-messages'

const HELP = 'want_to_help_task' as const

/** An in-progress project with an owner, a deputy, and `members` accepted onto it. */
async function setup(members: { id: number }[] = []) {
  const owner = await createVolunteer({ name: 'Olive Owner' })
  const deputy = await createVolunteer({ name: 'Dee Deputy' })
  const project = await createProject({
    assigneeId: owner.id,
    status: 'in_progress',
    title: 'Briefing',
  })
  for (const m of [deputy, ...members]) {
    await prisma.workItemInterest.create({
      data: {
        workItemId: project.id,
        volunteerId: m.id,
        interestType: 'want_to_contribute',
        status: 'accepted',
      },
    })
  }
  await prisma.projectDeputy.create({ data: { projectId: project.id, volunteerId: deputy.id } })
  return { owner, deputy, project }
}

const row = (volunteerId: number, workItemId: number) =>
  prisma.workItemInterest.findUniqueOrThrow({
    where: { volunteerId_workItemId: { volunteerId, workItemId } },
  })
const notes = (volunteerId: number, type: string) =>
  prisma.notification.findMany({ where: { volunteerId, type }, orderBy: { id: 'asc' } })
const noted = (volunteerId: number, type: string, count = 1) =>
  vi.waitFor(async () => {
    const rows = await notes(volunteerId, type)
    expect(rows).toHaveLength(count)
    return rows
  })
const offer = (who: { id: number }, projectId: number, taskId: number, message?: string) =>
  clientAs(who as never).projects.expressInterest({
    projectId,
    taskId,
    interestType: HELP,
    message,
  })
const answer = (
  who: { id: number },
  projectId: number,
  interestId: number,
  status: 'accepted' | 'declined',
) => clientAs(who as never).projects.respondToInterest({ projectId, interestId, status })

describe('offering to help on a task before joining the project', () => {
  it('holds the offer and asks the owner and deputies once, who see what it asks for', async () => {
    const { owner, deputy, project } = await setup()
    const sam = await createVolunteer({ name: 'Sam' })
    const task = await createTask(project.id, { title: 'Practise', helpersWanted: 1 })

    expect(
      await clientAs(sam).projects.getTask({ projectId: project.id, taskId: task.id }),
    ).toMatchObject({ canJoinAsHelper: true, hasOffered: false, offeredBy: [] })
    expect(await offer(sam, project.id, task.id, 'I can do Tuesdays')).toEqual({
      message: TASK_OFFER_SENT_MESSAGE,
      requested: true,
    })

    expect(await row(sam.id, task.id)).toMatchObject({ status: 'pending', interestType: HELP })
    const request = await row(sam.id, project.id)
    expect(request).toMatchObject({
      status: 'pending',
      interestType: 'want_to_contribute',
      message: 'I can do Tuesdays',
    })
    for (const to of [owner, deputy]) {
      const [n] = await noted(to.id, 'new_interest')
      expect(n).toMatchObject({
        body: "Sam offered to help on 'Practise': I can do Tuesdays",
        entityId: request.id,
      })
    }
    expect(await notes(sam.id, 'new_interest')).toHaveLength(0)

    const seen = await clientAs(sam).projects.getTask({ projectId: project.id, taskId: task.id })
    expect(seen).toMatchObject({
      canJoinAsHelper: false,
      hasOffered: true,
      isHelper: false,
      offeredBy: [{ volunteerId: sam.id, name: 'Sam' }],
      helpers: [],
    })
    await expect(offer(sam, project.id, task.id)).rejects.toMatchObject({
      message: 'You have already offered to help on this task',
    })

    // The deputy sees the request, and only requests; the owner sees what it asks for too.
    const forDeputy = await clientAs(deputy).projects.getById({ id: project.id })
    expect(forDeputy.interests?.map((i) => i.volunteerId)).toEqual([sam.id])
    const forOwner = await clientAs(owner).projects.getById({ id: project.id })
    expect(forOwner.interests?.find((i) => i.volunteerId === sam.id)?.asks).toEqual([
      { taskId: task.id, title: 'Practise', asHelper: true },
    ])
    expect(forOwner.interests?.find((i) => i.volunteerId === deputy.id)?.asks).toEqual([])

    // The deputy can answer it from the Inbox.
    const inbox = await clientAs(deputy).notifications.list({})
    expect(inbox.notifications.find((n) => n.type === 'new_interest')?.action).toMatchObject({
      kind: 'interest',
      interestId: request.id,
    })
  })

  it('puts them on the task and the project together when the owner accepts', async () => {
    const { owner, project } = await setup()
    const sam = await createVolunteer({ name: 'Sam' })
    const task = await createTask(project.id, { title: 'Practise', helpersWanted: 2 })
    const lead = await createTask(project.id, { title: 'Book a room' })
    await offer(sam, project.id, task.id)
    await clientAs(sam).projects.updateTask({
      projectId: project.id,
      taskId: lead.id,
      data: { assigneeId: sam.id },
    })
    const request = await row(sam.id, project.id)
    expect(
      (await clientAs(owner).projects.getById({ id: project.id })).interests?.find(
        (i) => i.id === request.id,
      )?.asks,
    ).toEqual([
      { taskId: lead.id, title: 'Book a room', asHelper: false },
      { taskId: task.id, title: 'Practise', asHelper: true },
    ])

    await answer(owner, project.id, request.id, 'accepted')
    expect((await row(sam.id, project.id)).status).toBe('accepted')
    expect((await row(sam.id, task.id)).status).toBe('accepted')
    expect((await prisma.workItem.findUniqueOrThrow({ where: { id: lead.id } })).assigneeId).toBe(
      sam.id,
    )
    await vi.waitFor(async () => expect(await notes(owner.id, 'new_interest')).toHaveLength(0))
    const feed = await clientAs(owner).workItemComments.list({ workItemId: task.id })
    expect(feed.feed.map((f) => ('text' in f ? f.text : null))).toContain(
      'Olive Owner added Sam as a helper',
    )
  })

  it('lets a deputy accept a request that comes with a task', async () => {
    const { deputy, project } = await setup()
    const sam = await createVolunteer({ name: 'Sam' })
    const task = await createTask(project.id, { helpersWanted: 1 })
    await offer(sam, project.id, task.id)
    await answer(deputy, project.id, (await row(sam.id, project.id)).id, 'accepted')
    expect((await row(sam.id, task.id)).status).toBe('accepted')
  })

  it('drops both the offer and the request when the owner declines', async () => {
    const { owner, project } = await setup()
    const sam = await createVolunteer()
    const task = await createTask(project.id, { helpersWanted: 1 })
    await offer(sam, project.id, task.id)
    await answer(owner, project.id, (await row(sam.id, project.id)).id, 'declined')
    expect((await row(sam.id, project.id)).status).toBe('declined')
    expect((await row(sam.id, task.id)).status).toBe('declined')
    // Turned down, they cannot offer again.
    await expect(offer(sam, project.id, task.id)).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })

  it('drops the request with the last offer withdrawn, and keeps it while another waits', async () => {
    const { owner, project } = await setup()
    const sam = await createVolunteer()
    const a = await createTask(project.id, { helpersWanted: 1 })
    const b = await createTask(project.id, { helpersWanted: 1 })
    const held = await createTask(project.id)
    await offer(sam, project.id, a.id)
    await offer(sam, project.id, b.id)
    await clientAs(sam).projects.updateTask({
      projectId: project.id,
      taskId: held.id,
      data: { assigneeId: sam.id },
    })
    const withdraw = (taskId: number) =>
      clientAs(sam).projects.withdrawInterest({ projectId: project.id, taskId })

    expect(await withdraw(a.id)).toEqual({ message: 'Offer withdrawn' })
    expect((await row(sam.id, a.id)).status).toBe('withdrawn')
    expect((await row(sam.id, project.id)).status).toBe('pending')
    expect(await withdraw(held.id)).toEqual({ message: 'Request withdrawn' })
    expect(
      (await prisma.workItem.findUniqueOrThrow({ where: { id: held.id } })).requestedById,
    ).toBeNull()
    expect((await row(sam.id, project.id)).status).toBe('pending')
    await noted(owner.id, 'new_interest', 3)

    await withdraw(b.id)
    expect((await row(sam.id, project.id)).status).toBe('withdrawn')
    await vi.waitFor(async () => expect(await notes(owner.id, 'new_interest')).toHaveLength(0))
    // Withdrawing leaves the way back open.
    await offer(sam, project.id, a.id)
    expect((await row(sam.id, a.id)).status).toBe('pending')
  })

  it('takes back every offer when they withdraw the whole request', async () => {
    const { project } = await setup()
    const sam = await createVolunteer()
    const task = await createTask(project.id, { helpersWanted: 1 })
    await offer(sam, project.id, task.id)
    await clientAs(sam).projects.withdrawInterest({ projectId: project.id })
    expect((await row(sam.id, task.id)).status).toBe('withdrawn')
  })

  it('gives the last place to the first accepted, and tells the other it is filled', async () => {
    const { owner, project } = await setup()
    const ann = await createVolunteer({ name: 'Ann' })
    const bob = await createVolunteer({ name: 'Bob' })
    const task = await createTask(project.id, { title: 'Practise', helpersWanted: 1 })
    await offer(ann, project.id, task.id)
    await offer(bob, project.id, task.id)
    expect(
      (await clientAs(owner).projects.getTask({ projectId: project.id, taskId: task.id }))
        .offeredBy,
    ).toEqual([
      { volunteerId: ann.id, name: 'Ann' },
      { volunteerId: bob.id, name: 'Bob' },
    ])

    await answer(owner, project.id, (await row(ann.id, project.id)).id, 'accepted')
    expect((await row(ann.id, task.id)).status).toBe('accepted')
    expect(await row(bob.id, task.id)).toMatchObject({
      status: 'declined',
      responseMessage: PLACE_FILLED,
    })
    // Bob asked only for that place, so his request goes too, and he is told.
    expect((await row(bob.id, project.id)).status).toBe('withdrawn')
    expect((await noted(bob.id, 'helper_place_filled'))[0].title).toBe(
      "Place filled: 'Practise' is not taking more helpers",
    )
    // Withdrawn rather than declined, so he can offer on something else.
    const other = await createTask(project.id, { helpersWanted: 1 })
    await offer(bob, project.id, other.id)
  })

  it('never gives the last place twice when both are accepted at once', async () => {
    const { owner, deputy, project } = await setup()
    const ann = await createVolunteer()
    const bob = await createVolunteer()
    const task = await createTask(project.id, { helpersWanted: 1 })
    const keep = await createTask(project.id, { helpersWanted: 5 })
    await offer(ann, project.id, task.id)
    await offer(bob, project.id, task.id)
    // Each also asks for another place, so both requests stay open until answered.
    await offer(ann, project.id, keep.id)
    await offer(bob, project.id, keep.id)
    const [annRequest, bobRequest] = [await row(ann.id, project.id), await row(bob.id, project.id)]
    await Promise.all([
      answer(owner, project.id, annRequest.id, 'accepted'),
      answer(deputy, project.id, bobRequest.id, 'accepted'),
    ])
    const statuses = [(await row(ann.id, task.id)).status, (await row(bob.id, task.id)).status]
    expect(statuses.sort()).toEqual(['accepted', 'declined'])
    expect(
      await prisma.workItemInterest.count({ where: { workItemId: task.id, status: 'accepted' } }),
    ).toBe(1)
    expect((await row(ann.id, keep.id)).status).toBe('accepted')
    expect((await row(bob.id, keep.id)).status).toBe('accepted')
  })

  it('closes waiting offers once a member, or a smaller ask, fills the task', async () => {
    const member = await createVolunteer()
    const { owner, project } = await setup([member])
    const sam = await createVolunteer()
    const task = await createTask(project.id, { helpersWanted: 1 })
    await offer(sam, project.id, task.id)
    await offer(member, project.id, task.id)
    expect((await row(member.id, task.id)).status).toBe('accepted')
    expect((await row(sam.id, task.id)).responseMessage).toBe(PLACE_FILLED)

    const other = await createTask(project.id, { helpersWanted: 2 })
    const kim = await createVolunteer()
    await offer(sam, project.id, other.id)
    await offer(kim, project.id, other.id)
    await clientAs(owner).projects.updateTask({
      projectId: project.id,
      taskId: other.id,
      data: { helpersWanted: null },
    })
    expect((await row(sam.id, other.id)).responseMessage).toBe(PLACE_FILLED)
    expect((await row(kim.id, other.id)).responseMessage).toBe(PLACE_FILLED)
  })

  it('tells someone accepted whose place went while they waited', async () => {
    const member = await createVolunteer()
    const { owner, project } = await setup([member])
    const sam = await createVolunteer()
    const task = await createTask(project.id, { title: 'Practise', helpersWanted: 2 })
    await offer(sam, project.id, task.id)
    // The place goes another way than through the offers: the owner asks for fewer helpers
    // and someone already helping stays.
    await offer(member, project.id, task.id)
    await prisma.workItem.update({ where: { id: task.id }, data: { helpersWanted: 1 } })
    await answer(owner, project.id, (await row(sam.id, project.id)).id, 'accepted')
    expect((await row(sam.id, project.id)).status).toBe('accepted')
    expect((await row(sam.id, task.id)).responseMessage).toBe(PLACE_FILLED)
    await noted(sam.id, 'helper_place_filled')
  })

  it('answers an invite when they offer, and joins them straight away', async () => {
    const { owner, project } = await setup()
    const sam = await createVolunteer()
    const task = await createTask(project.id, { helpersWanted: 1 })
    await clientAs(owner).projects.invite({ projectId: project.id, volunteerId: sam.id })
    expect(await offer(sam, project.id, task.id)).toMatchObject({ requested: false })
    expect((await row(sam.id, project.id)).status).toBe('accepted')
    expect((await row(sam.id, task.id)).status).toBe('accepted')
  })

  it('refuses an offer on a project they cannot reach, or a task with no room', async () => {
    const chapter = await createChapter()
    const { project: theirs } = await setup()
    await prisma.workItem.update({
      where: { id: theirs.id },
      data: { nationalChapterId: chapter.id, isOrgProposed: false },
    })
    const member = await createVolunteer()
    const { project } = await setup([member])
    const outsider = await createMember(await createChapter())
    const task = await createTask(theirs.id, { helpersWanted: 1 })
    await expect(offer(outsider, theirs.id, task.id)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })

    const full = await createTask(project.id, { helpersWanted: 1 })
    await offer(member, project.id, full.id)
    await expect(offer(await createVolunteer(), project.id, full.id)).rejects.toMatchObject({
      message: 'This task has all the helpers it wants',
    })
  })
})

describe('a manager putting someone not on the project on a task', () => {
  it('brings them onto the project when they are made lead or a helper', async () => {
    const { owner, deputy, project } = await setup()
    const ann = await createVolunteer()
    const bob = await createVolunteer()
    const cat = await createVolunteer()
    const a = await createTask(project.id)
    const b = await createTask(project.id)
    const c = await createTask(project.id, { helpersWanted: 1 })

    await clientAs(deputy).projects.assignTask({
      projectId: project.id,
      taskId: a.id,
      assigneeId: ann.id,
    })
    expect(await row(ann.id, project.id)).toMatchObject({ status: 'accepted', origin: 'added' })

    await clientAs(owner).projects.updateTask({
      projectId: project.id,
      taskId: b.id,
      data: { assigneeId: bob.id },
    })
    expect((await row(bob.id, project.id)).status).toBe('accepted')

    await clientAs(owner).projects.addTaskHelper({
      projectId: project.id,
      taskId: c.id,
      volunteerId: cat.id,
    })
    expect((await row(cat.id, project.id)).status).toBe('accepted')
    expect((await row(cat.id, c.id)).status).toBe('accepted')
  })

  it('accepts a waiting request with it, settling the rest of what they asked for', async () => {
    const { owner, project } = await setup()
    const sam = await createVolunteer()
    const asked = await createTask(project.id, { helpersWanted: 1 })
    const also = await createTask(project.id, { helpersWanted: 1 })
    await offer(sam, project.id, asked.id)
    await offer(sam, project.id, also.id)
    const request = await row(sam.id, project.id)

    // Made lead of the task they offered to help on, they stop offering on it.
    await clientAs(owner).projects.assignTask({
      projectId: project.id,
      taskId: asked.id,
      assigneeId: sam.id,
    })
    expect(await row(sam.id, project.id)).toMatchObject({ id: request.id, status: 'accepted' })
    expect((await row(sam.id, asked.id)).status).toBe('withdrawn')
    expect((await row(sam.id, also.id)).status).toBe('accepted')
    expect(await notes(sam.id, 'helper_place_filled')).toHaveLength(0)
  })

  it('adds someone who left back, and refuses whoever cannot join', async () => {
    const { owner, project } = await setup()
    const left = await createVolunteer()
    await prisma.workItemInterest.create({
      data: {
        workItemId: project.id,
        volunteerId: left.id,
        interestType: 'want_to_contribute',
        status: 'withdrawn',
      },
    })
    const task = await createTask(project.id, { helpersWanted: 2 })
    await clientAs(owner).projects.addTaskHelper({
      projectId: project.id,
      taskId: task.id,
      volunteerId: left.id,
    })
    expect(await row(left.id, project.id)).toMatchObject({ status: 'accepted', origin: 'added' })

    const unapproved = await createVolunteer({ approvalStatus: 'pending' })
    await expect(
      clientAs(owner).projects.addTaskHelper({
        projectId: project.id,
        taskId: task.id,
        volunteerId: unapproved.id,
      }),
    ).rejects.toMatchObject({
      message: 'Cannot put a volunteer who is not yet approved on a task',
    })
    await expect(
      clientAs(owner).projects.updateTask({
        projectId: project.id,
        taskId: (await createTask(project.id)).id,
        data: { assigneeId: unapproved.id },
      }),
    ).rejects.toMatchObject({
      message: 'Cannot put a volunteer who is not yet approved on a task',
    })
    await expect(
      clientAs(owner).projects.updateTask({
        projectId: project.id,
        taskId: (await createTask(project.id)).id,
        data: { assigneeId: 999_999 },
      }),
    ).rejects.toMatchObject({ message: 'Volunteer not found' })
    const elsewhere = await createMember(await createChapter())
    await expect(
      clientAs(owner).projects.assignTask({
        projectId: project.id,
        taskId: task.id,
        assigneeId: elsewhere.id,
      }),
    ).rejects.toMatchObject({ message: 'They are in another national chapter' })
  })

  it('leaves someone the owner turned down off, unless an admin puts them back', async () => {
    const { deputy, project } = await setup()
    const removed = await createVolunteer()
    await prisma.workItemInterest.create({
      data: {
        workItemId: project.id,
        volunteerId: removed.id,
        interestType: 'want_to_contribute',
        status: 'removed',
      },
    })
    const task = await createTask(project.id)
    await expect(
      clientAs(deputy).projects.assignTask({
        projectId: project.id,
        taskId: task.id,
        assigneeId: removed.id,
      }),
    ).rejects.toMatchObject({
      message: 'The owner turned them down or took them off this project',
    })
    expect((await row(removed.id, project.id)).status).toBe('removed')

    await clientAs(await createAdmin()).projects.assignTask({
      projectId: project.id,
      taskId: task.id,
      assigneeId: removed.id,
    })
    expect(await row(removed.id, project.id)).toMatchObject({ status: 'accepted', origin: 'added' })
  })

  it('answers an invite when they are given a task, and its notification goes', async () => {
    const { owner, project } = await setup()
    const sam = await createVolunteer()
    await clientAs(owner).projects.invite({ projectId: project.id, volunteerId: sam.id })
    await noted(sam.id, 'project_invite')
    await clientAs(owner).projects.assignTask({
      projectId: project.id,
      taskId: (await createTask(project.id)).id,
      assigneeId: sam.id,
    })
    expect((await row(sam.id, project.id)).status).toBe('accepted')
    await vi.waitFor(async () => expect(await notes(sam.id, 'project_invite')).toHaveLength(0))
  })

  it('makes someone offering to lead an ownerless project a member, not its owner', async () => {
    const admin = await createAdmin()
    const project = await createProject({ status: 'ready', isSeekingHelp: true })
    const ann = await createVolunteer()
    await clientAs(ann).projects.expressInterest({
      projectId: project.id,
      interestType: 'want_to_own',
      message: 'I can run it',
    })
    // Offering to help on a task too keeps the offer to lead, and its message, as they were.
    const task = await createTask(project.id, { helpersWanted: 1 })
    await offer(ann, project.id, task.id, 'And help')
    expect(await row(ann.id, project.id)).toMatchObject({
      status: 'pending',
      interestType: 'want_to_own',
      message: 'I can run it',
    })
    // Someone else takes the place: Ann's offer closes, her offer to lead stays.
    const bob = await createVolunteer()
    await clientAs(admin).projects.addTaskHelper({
      projectId: project.id,
      taskId: task.id,
      volunteerId: bob.id,
    })
    expect((await row(ann.id, task.id)).responseMessage).toBe(PLACE_FILLED)
    expect((await row(ann.id, project.id)).status).toBe('pending')

    await clientAs(admin).projects.assignTask({
      projectId: project.id,
      taskId: (await createTask(project.id)).id,
      assigneeId: ann.id,
    })
    expect(await row(ann.id, project.id)).toMatchObject({
      status: 'accepted',
      interestType: 'want_to_contribute',
    })
    expect(
      (await prisma.workItem.findUniqueOrThrow({ where: { id: project.id } })).assigneeId,
    ).toBeNull()
  })
})

describe('offers on a task that changes', () => {
  it('closes waiting offers once the task is handed in, dropping the request with them', async () => {
    const lead = await createVolunteer()
    const { project } = await setup([lead])
    const sam = await createVolunteer()
    const task = await createTask(project.id, {
      assigneeId: lead.id,
      status: 'in_progress',
      helpersWanted: 2,
    })
    await offer(sam, project.id, task.id)
    await clientAs(lead).projects.submitTask({
      projectId: project.id,
      taskId: task.id,
      note: 'Done',
    })
    expect((await row(sam.id, task.id)).responseMessage).toBe(PLACE_FILLED)
    expect((await row(sam.id, project.id)).status).toBe('withdrawn')
    expect(
      await clientAs(sam).projects.getTask({ projectId: project.id, taskId: task.id }),
    ).toMatchObject({ hasOffered: false, offeredBy: [] })
  })

  it('refuses an offer to help on a task they already asked to take', async () => {
    const { owner, project } = await setup()
    const sam = await createVolunteer()
    const task = await createTask(project.id, { helpersWanted: 1 })
    await clientAs(sam).projects.updateTask({
      projectId: project.id,
      taskId: task.id,
      data: { assigneeId: sam.id },
    })
    expect(
      await clientAs(sam).projects.getTask({ projectId: project.id, taskId: task.id }),
    ).toMatchObject({ canJoinAsHelper: false })
    await expect(offer(sam, project.id, task.id)).rejects.toMatchObject({
      message: "You've already asked to take this task",
    })
    // Accepted, they lead it and hear nothing about a place.
    await answer(owner, project.id, (await row(sam.id, project.id)).id, 'accepted')
    expect((await prisma.workItem.findUniqueOrThrow({ where: { id: task.id } })).assigneeId).toBe(
      sam.id,
    )
    expect(await notes(sam.id, 'helper_place_filled')).toHaveLength(0)
  })

  it('leaves an invite unanswered when the place they tried for is gone', async () => {
    const member = await createVolunteer()
    const { owner, project } = await setup([member])
    const sam = await createVolunteer()
    const task = await createTask(project.id, { helpersWanted: 1 })
    await clientAs(owner).projects.invite({ projectId: project.id, volunteerId: sam.id })
    await offer(member, project.id, task.id)
    await expect(offer(sam, project.id, task.id)).rejects.toMatchObject({
      message: 'This task has all the helpers it wants',
    })
    expect((await row(sam.id, project.id)).status).toBe('invited')
  })

  it('tells only the owner about a request that comes with an offer to lead', async () => {
    const { owner, deputy, project } = await setup()
    const ann = await createVolunteer()
    await prisma.workItemInterest.create({
      data: {
        workItemId: project.id,
        volunteerId: ann.id,
        interestType: 'want_to_own',
        status: 'pending',
      },
    })
    await offer(ann, project.id, (await createTask(project.id, { helpersWanted: 1 })).id)
    await noted(owner.id, 'new_interest')
    expect(await notes(deputy.id, 'new_interest')).toHaveLength(0)
  })
})
