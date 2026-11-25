import { describe, it, expect } from 'vitest'
import { prisma } from '@/lib/prisma'
import {
  createAdmin,
  createChapter,
  createMember,
  createProject,
  createTask,
} from '@/test/factories'
import { clientAs } from '@/test/rpc'

const HELP = 'want_to_help_task' as const

const join = (projectId: number, volunteerId: number, status = 'accepted' as const) =>
  prisma.workItemInterest.create({
    data: { workItemId: projectId, volunteerId, interestType: 'want_to_contribute', status },
  })

/** A running project in `chapter`, owned by Olive. */
async function projectIn(chapter: { id: number; country: string }, title = 'Briefing') {
  const owner = await createMember(chapter, { name: 'Olive Owner' })
  const project = await createProject({
    assigneeId: owner.id,
    status: 'in_progress',
    nationalChapterId: chapter.id,
    title,
  })
  return { owner, project }
}

const places = async (who: { id: number }) =>
  (await clientAs(who as never).quickTasks.available()).filter((t) => t.kind === 'helper_place')

describe('tasks with open helper places', () => {
  it('lists them on Quick Tasks and Home, with who is asking and who has offered', async () => {
    const uk = await createChapter()
    const { owner, project } = await projectIn(uk)
    const me = await createMember(uk)
    const lead = await createMember(uk, { name: 'Lee Lead' })
    const sam = await createMember(uk, { name: 'Sam' })
    await join(project.id, lead.id)
    const led = await createTask(project.id, {
      title: 'Practise',
      assigneeId: lead.id,
      helpersWanted: 2,
    })
    const unled = await createTask(project.id, { title: 'Stall', helpersWanted: 1 })
    await clientAs(sam).projects.expressInterest({
      projectId: project.id,
      taskId: led.id,
      interestType: HELP,
    })

    const listed = await places(me)
    expect(listed.map((t) => t.title).sort()).toEqual(['Practise', 'Stall'])
    expect(listed.find((t) => t.id === led.id)).toMatchObject({
      projectId: project.id,
      projectTitle: 'Briefing',
      askedBy: { id: lead.id, name: 'Lee Lead' },
      placesLeft: 2,
      offeredBy: [{ id: sam.id, name: 'Sam' }],
      claimViewer: { onProject: false, invited: false },
    })
    // A task nobody leads is asked for by the project's owner.
    expect(listed.find((t) => t.id === unled.id)?.askedBy).toEqual({
      id: owner.id,
      name: 'Olive Owner',
    })

    const { find } = await clientAs(me).dashboard.get()
    expect(find?.helpersWanted.count).toBe(2)
    expect(find?.helpersWanted.items.find((i) => i.id === led.id)).toEqual({
      id: led.id,
      title: 'Practise',
      href: `/projects/${project.id}/tasks/${led.id}`,
      reason: 'Lee Lead is asking for 2 helpers · Sam has offered',
    })
  })

  it('leaves out places that are gone, not theirs to take, or out of reach', async () => {
    const uk = await createChapter()
    const fr = await createChapter()
    const { owner, project } = await projectIn(uk)
    const me = await createMember(uk)
    const other = await createMember(uk)
    await join(project.id, other.id)
    const wanted = await createTask(project.id, { title: 'Wanted', helpersWanted: 1 })
    const full = await createTask(project.id, { title: 'Full', helpersWanted: 1 })
    await clientAs(other).projects.expressInterest({
      projectId: project.id,
      taskId: full.id,
      interestType: HELP,
    })
    await createTask(project.id, { title: 'Solo', helpersWanted: null })
    await createTask(project.id, {
      title: 'Handed in',
      status: 'under_review',
      helpersWanted: 2,
    })
    await createTask(project.id, { title: 'Mine', assigneeId: me.id, helpersWanted: 2 })
    const offered = await createTask(project.id, { title: 'Offered', helpersWanted: 2 })
    await clientAs(me).projects.expressInterest({
      projectId: project.id,
      taskId: offered.id,
      interestType: HELP,
    })
    // Another chapter's project, a finished one and a draft are not offered.
    const { project: abroad } = await projectIn(fr, 'Abroad')
    await createTask(abroad.id, { title: 'Abroad task', helpersWanted: 2 })
    const done = await createProject({ status: 'completed', nationalChapterId: uk.id })
    await createTask(done.id, { title: 'Done project task', helpersWanted: 2 })
    const draft = await createProject({ status: 'draft', nationalChapterId: uk.id })
    await createTask(draft.id, { title: 'Draft task', helpersWanted: 2 })

    expect((await places(me)).map((t) => t.id)).toEqual([wanted.id])
    // The owner adds helpers to their own project's tasks rather than being offered them.
    expect(await places(owner)).toEqual([])

    // Turned down by the owner, they are offered nothing on that project.
    const turnedDown = await createMember(uk)
    await join(project.id, turnedDown.id, 'declined' as never)
    expect(await places(turnedDown)).toEqual([])
  })
})

describe('the assign and add-helper pickers', () => {
  it("search the manager's own chapter, or the project's for a global admin", async () => {
    const uk = await createChapter()
    const fr = await createChapter()
    const { owner, project } = await projectIn(uk)
    const near = await createMember(uk, { name: 'Pickme Near' })
    const far = await createMember(fr, { name: 'Pickme Far' })
    const search = async (who: { id: number }, chapter?: number) =>
      (await clientAs(who as never).volunteers.list({ search: 'Pickme', chapter })).volunteers.map(
        (v) => v.name,
      )

    // An owner finds anyone in their chapter, not only the project's members.
    expect(await search(owner)).toEqual(['Pickme Near'])
    expect(await search(owner, fr.id)).toEqual(['Pickme Near'])
    const admin = await createAdmin()
    expect(await search(admin, uk.id)).toEqual(['Pickme Near'])

    // Whoever the owner finds can be given the task, and joins the project with it.
    const task = await createTask(project.id, { helpersWanted: 1 })
    await clientAs(owner).projects.addTaskHelper({
      projectId: project.id,
      taskId: task.id,
      volunteerId: near.id,
    })
    expect(
      (
        await prisma.workItemInterest.findFirstOrThrow({
          where: { workItemId: project.id, volunteerId: near.id },
        })
      ).status,
    ).toBe('accepted')
    await expect(
      clientAs(owner).projects.assignTask({
        projectId: project.id,
        taskId: task.id,
        assigneeId: far.id,
      }),
    ).rejects.toMatchObject({ message: 'They are in another national chapter' })
  })

  it("offer the project's owner and members first on the task page", async () => {
    const uk = await createChapter()
    const { owner, project } = await projectIn(uk)
    const ann = await createMember(uk, { name: 'Ann Member' })
    await join(project.id, ann.id)
    const task = await createTask(project.id, { assigneeId: ann.id })
    const seen = await clientAs(owner).projects.getTask({
      projectId: project.id,
      taskId: task.id,
    })
    expect(seen.projectPeople).toEqual([
      { title: 'Owner', people: [{ id: owner.id, name: 'Olive Owner' }] },
      { title: 'Deputies', people: [] },
      { title: 'Members', people: [{ id: ann.id, name: 'Ann Member' }] },
      { title: 'Asking to join', people: [] },
    ])
    expect(seen.searchChapter).toBeUndefined()
    const admin = await createAdmin()
    expect(
      (await clientAs(admin).projects.getTask({ projectId: project.id, taskId: task.id }))
        .searchChapter,
    ).toBe(uk.id)
    // Someone who doesn't run its tasks is offered nobody.
    expect(
      (await clientAs(ann).projects.getTask({ projectId: project.id, taskId: task.id }))
        .projectPeople,
    ).toEqual([
      { title: 'Owner', people: [] },
      { title: 'Deputies', people: [] },
      { title: 'Members', people: [] },
      { title: 'Asking to join', people: [] },
    ])
  })
})

describe('a featured task that also wants helpers', () => {
  it('is listed once on Quick Tasks, to claim', async () => {
    const uk = await createChapter()
    const { project } = await projectIn(uk)
    const me = await createMember(uk)
    const task = await createTask(project.id, { featuredAsQuickTask: true, helpersWanted: 2 })
    const listed = (await clientAs(me).quickTasks.available()).filter((t) => t.id === task.id)
    expect(listed.map((t) => t.kind)).toEqual(['project_task'])
  })
})
