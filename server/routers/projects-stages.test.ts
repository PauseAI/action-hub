import { describe, it, expect } from 'vitest'
import { prisma } from '@/lib/prisma'
import { createAdmin, createProject, createTask, createVolunteer } from '@/test/factories'
import { clientAs } from '@/test/rpc'

const OUTLINE = 'This is still an outline item. The owner needs to plan it into a task first'

const proposal = {
  title: 'Leaflet the high street',
  description: 'Hand out leaflets so shoppers hear about the pause',
  collaborationLink: null,
  projectType: null,
  estimatedDuration: null,
  timeCommitmentHoursPerWeek: null,
  urgency: 'medium',
  isSeekingHelp: true,
}

const task = (id: number) => prisma.workItem.findUniqueOrThrow({ where: { id } })

/** A volunteer's proposal with outline items, approved and so in Planning, owned by them. */
async function inPlanning() {
  const admin = await createAdmin()
  const owner = await createVolunteer({ name: 'Olive Owner' })
  const { id } = await clientAs(owner).projects.create({
    ...proposal,
    wantToOwn: true,
    tasks: [{ title: 'Print leaflets' }, { title: 'Pick a Saturday' }],
  })
  await clientAs(admin).admin.projects.review({ id, status: 'approved' })
  const [print, saturday] = await prisma.workItem.findMany({
    where: { parentId: id },
    orderBy: { id: 'asc' },
  })
  return { admin, owner, projectId: id, print, saturday }
}

describe('Proposal: outline items', () => {
  it('makes the tasks of a volunteer proposal outline items, however they are added', async () => {
    const me = await createVolunteer()
    const c = clientAs(me)
    const { id } = await c.projects.create({
      ...proposal,
      saveAsDraft: true,
      tasks: [{ title: 'Print leaflets' }],
    })
    const added = await c.projects.createTask({
      projectId: id,
      title: 'Pick a Saturday',
      featuredAsQuickTask: true,
    })
    const rows = await prisma.workItem.findMany({ where: { parentId: id }, orderBy: { id: 'asc' } })
    expect(rows.map((t) => [t.title, t.isOutline, t.featuredAsQuickTask])).toEqual([
      ['Print leaflets', true, false],
      ['Pick a Saturday', true, false],
    ])
    expect((await c.projects.getById({ id })).stage).toBe('proposal')

    // Still a skeleton: it can't be planned into a task before approval.
    await expect(
      c.projects.updateTask({ projectId: id, taskId: added.id, data: { isOutline: false } }),
    ).rejects.toMatchObject({
      message: 'Outline items are planned into tasks once the project is approved',
    })
  })

  it('keeps org drafts whole: real tasks, planned the moment they publish', async () => {
    const admin = await createAdmin()
    const c = clientAs(admin)
    const org = await createProject({ status: 'draft', isOrgProposed: true, creatorId: admin.id })
    const { id: taskId } = await c.projects.createTask({ projectId: org.id, title: 'Book a hall' })
    expect((await task(taskId)).isOutline).toBe(false)
    // One that somehow holds an outline item still publishes whole.
    const outline = await createTask(org.id, { isOutline: true })
    expect(await c.projects.publishDraft({ id: org.id })).toEqual({ message: 'Project published' })
    expect((await task(outline.id)).isOutline).toBe(false)
    expect((await c.projects.getById({ id: org.id })).stage).toBe('running')
  })
})

describe('Planning: an outline item waits to be planned', () => {
  it('lets nobody take, start, submit, help on or feature an outline item', async () => {
    const { owner, projectId, print } = await inPlanning()
    const member = await createVolunteer()
    await prisma.workItemInterest.create({
      data: {
        workItemId: projectId,
        volunteerId: member.id,
        interestType: 'want_to_contribute',
        status: 'accepted',
      },
    })
    const o = clientAs(owner)
    const m = clientAs(member)
    const ref = { projectId, taskId: print.id }

    await o.projects.updateTask({ ...ref, data: { helpersWanted: 2 } })
    expect(await m.projects.getTask(ref)).toMatchObject({
      isOutline: true,
      canClaim: false,
      canJoinAsHelper: false,
    })
    const { tasks } = await o.projects.getById({ id: projectId })
    expect(tasks.find((t) => t.id === print.id)?.isOutline).toBe(true)

    await expect(
      m.projects.updateTask({ ...ref, data: { assigneeId: member.id } }),
    ).rejects.toMatchObject({ message: OUTLINE })
    await expect(o.projects.assignTask({ ...ref, assigneeId: member.id })).rejects.toMatchObject({
      message: OUTLINE,
    })
    await expect(
      o.projects.updateTask({ ...ref, data: { featuredAsQuickTask: true } }),
    ).rejects.toMatchObject({ message: OUTLINE })
    await expect(
      o.projects.updateTask({ ...ref, data: { status: 'in_progress' } }),
    ).rejects.toMatchObject({ message: OUTLINE })
    await expect(
      m.projects.expressInterest({ ...ref, interestType: 'want_to_help_task' }),
    ).rejects.toMatchObject({ message: OUTLINE })

    // Even one somehow assigned can't be worked on.
    await prisma.workItem.update({ where: { id: print.id }, data: { assigneeId: owner.id } })
    await expect(o.projects.startTask(ref)).rejects.toMatchObject({ message: OUTLINE })
    await expect(o.projects.submitTask({ ...ref, note: 'Done' })).rejects.toMatchObject({
      message: OUTLINE,
    })
    expect(await task(print.id)).toMatchObject({
      status: 'not_started',
      featuredAsQuickTask: false,
    })

    // Renaming an outline item is fine.
    await o.projects.updateTask({ ...ref, data: { title: 'Print 500 leaflets' } })
    expect((await task(print.id)).title).toBe('Print 500 leaflets')
  })

  it('plans an outline item into a task with its details in one save', async () => {
    const { owner, projectId, print } = await inPlanning()
    const o = clientAs(owner)
    expect((await o.projects.getById({ id: projectId })).stage).toBe('planning')
    await o.projects.updateTask({
      projectId,
      taskId: print.id,
      data: {
        isOutline: false,
        estimatedHours: 3,
        helpersWanted: 2,
        featuredAsQuickTask: true,
        assigneeId: owner.id,
      },
    })
    expect(await task(print.id)).toMatchObject({
      isOutline: false,
      estimatedHours: 3,
      helpersWanted: 2,
      featuredAsQuickTask: true,
      assigneeId: owner.id,
    })
    const { tasks } = await o.projects.listTasks({ projectId })
    expect(tasks.find((t) => t.id === print.id)?.isOutline).toBe(false)
  })

  it('records a total-hours estimate for the project', async () => {
    const { owner, projectId } = await inPlanning()
    const o = clientAs(owner)
    await o.projects.update({ id: projectId, estimatedTotalHours: 40 })
    expect((await o.projects.getById({ id: projectId })).estimatedTotalHours).toBe(40)
    await expect(o.projects.update({ id: projectId, estimatedTotalHours: 0 })).rejects.toThrow()
    await o.projects.update({ id: projectId, estimatedTotalHours: null })
    expect((await task(projectId)).estimatedTotalHours).toBeNull()
  })
})

describe('Finish planning', () => {
  it('needs an owner and one real task, and is the owner’s or staff’s to do', async () => {
    const { admin, owner, projectId, print } = await inPlanning()
    const o = clientAs(owner)
    const outsider = await createVolunteer()

    await expect(o.projects.finishPlanning({ id: projectId })).rejects.toMatchObject({
      message: 'Plan at least one task before finishing planning',
    })
    await o.projects.updateTask({ projectId, taskId: print.id, data: { isOutline: false } })
    await expect(
      clientAs(outsider).projects.finishPlanning({ id: projectId }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })

    await clientAs(admin).projects.update({ id: projectId, assigneeId: null })
    await expect(clientAs(admin).projects.finishPlanning({ id: projectId })).rejects.toMatchObject({
      message: 'The project needs an owner before planning can finish',
    })
    await clientAs(admin).projects.update({ id: projectId, assigneeId: owner.id })

    // The other outline item can stay rough.
    expect(await o.projects.finishPlanning({ id: projectId })).toEqual({
      message: 'Planning finished',
    })
    const project = await o.projects.getById({ id: projectId })
    expect(project.stage).toBe('running')
    expect(project.plannedAt).not.toBeNull()
    await expect(o.projects.finishPlanning({ id: projectId })).rejects.toMatchObject({
      message: 'This project is not being planned',
    })

    const events = await prisma.workItemEvent.findMany({ where: { workItemId: projectId } })
    expect(events.some((e) => (e.after as Record<string, unknown>).plannedAt)).toBe(true)
  })

  it('refuses a proposal and a missing project', async () => {
    const admin = await createAdmin()
    const c = clientAs(admin)
    const draft = await createProject({ status: 'pending_review', assigneeId: admin.id })
    await expect(c.projects.finishPlanning({ id: draft.id })).rejects.toMatchObject({
      message: 'This project is not being planned',
    })
    await expect(c.projects.finishPlanning({ id: 999_999 })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
  })
})

describe('quick tasks', () => {
  it('never offers an outline item, even one flagged as featured', async () => {
    const me = await createVolunteer()
    const project = await createProject({ nationalChapterId: me.nationalChapterId })
    const outline = await createTask(project.id, { featuredAsQuickTask: true, isOutline: true })
    const real = await createTask(project.id, { featuredAsQuickTask: true })
    const offered = (await clientAs(me).quickTasks.available()).map((t) => t.id)
    expect(offered).toContain(real.id)
    expect(offered).not.toContain(outline.id)
  })
})

describe('stage edge cases', () => {
  it('counts a project finished mid-plan as past planning, and keeps a planned project planned', async () => {
    const admin = await createAdmin()
    const c = clientAs(admin)
    const done = await createProject({ status: 'completed', plannedAt: null })
    expect((await c.projects.getById({ id: done.id })).stage).toBe('running')

    // Sent back for changes after it was planned: new tasks are real, not outline items.
    const planned = await createProject({ status: 'needs_discussion', assigneeId: admin.id })
    await prisma.workItem.update({ where: { id: planned.id }, data: { plannedAt: new Date() } })
    const { id } = await c.projects.createTask({ projectId: planned.id, title: 'More' })
    expect((await task(id)).isOutline).toBe(false)
  })

  it('will not move a project with only outline items to In progress', async () => {
    const { owner, projectId } = await inPlanning()
    await expect(
      clientAs(owner).projects.update({ id: projectId, status: 'in_progress' }),
    ).rejects.toMatchObject({
      message: 'A project cannot be moved to In Progress without at least one open task',
    })
  })
})
