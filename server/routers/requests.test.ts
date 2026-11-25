import { describe, it, expect, vi } from 'vitest'
import { prisma } from '@/lib/prisma'
import {
  createChapter,
  createChapterLead,
  createMember,
  createProject,
  createVolunteer,
} from '@/test/factories'
import { clientAs } from '@/test/rpc'

const notes = (volunteerId: number, type: string) =>
  prisma.notification.findMany({ where: { volunteerId, type }, orderBy: { id: 'asc' } })

async function chapterWithPeople() {
  const chapter = await createChapter()
  const lead = await createChapterLead(chapter, { name: 'Lee Lead' })
  const asker = await createMember(chapter, { name: 'Ada Asker' })
  const taker = await createMember(chapter, { name: 'Tom Taker' })
  return { chapter, lead, asker, taker }
}

const ask = (who: { id: number }, title = 'Proofread the flyer', extra = {}) =>
  clientAs(who as never).requests.ask({ title, ...extra })

describe('asking for help', () => {
  it("puts the request in the chapter's standing project, made once, with nobody owning it", async () => {
    const { chapter, asker, taker } = await chapterWithPeople()
    const [first, second] = await Promise.all([ask(asker), ask(taker, 'Hand out leaflets')])
    expect(first.projectId).toBe(second.projectId)
    expect(first.message).toBe('Request posted')

    const project = await prisma.workItem.findUniqueOrThrow({ where: { id: first.projectId } })
    expect(project).toMatchObject({
      type: 'PROJECT',
      standingRequests: true,
      nationalChapterId: chapter.id,
      assigneeId: null,
      status: 'in_progress',
      title: `Requests for help: ${chapter.name}`,
    })
    const task = await prisma.workItem.findUniqueOrThrow({ where: { id: first.id } })
    expect(task).toMatchObject({ type: 'TASK', creatorId: asker.id, status: 'not_started' })

    const shown = await clientAs(taker).projects.getById({ id: project.id })
    expect(shown.isSeekingOwner).toBe(false)
    await expect(
      clientAs(taker).projects.expressInterest({
        projectId: project.id,
        interestType: 'want_to_own',
      }),
    ).rejects.toMatchObject({ message: 'This project is not looking for a lead' })
  })

  it('asks every chapter in the global project, which anyone can see and take', async () => {
    const { asker } = await chapterWithPeople()
    const elsewhere = await chapterWithPeople()
    const pooled = await createVolunteer({ name: 'Pat Pool' })
    const posted = await ask(asker, 'Translate a post', { global: true, estimatedHours: 2 })
    const fromPool = await ask(pooled, 'Check a spreadsheet')
    expect(fromPool.projectId).toBe(posted.projectId)
    const project = await prisma.workItem.findUniqueOrThrow({ where: { id: posted.projectId } })
    expect(project).toMatchObject({ nationalChapterId: null, title: 'Global requests' })

    const feed = await clientAs(elsewhere.taker).quickTasks.available()
    expect(feed).toContainEqual(
      expect.objectContaining({
        kind: 'request',
        id: posted.id,
        askedBy: { id: asker.id, name: 'Ada Asker' },
        global: true,
        estimatedHours: 2,
      }),
    )
    const task = await clientAs(elsewhere.taker).projects.getTask({
      projectId: posted.projectId,
      taskId: posted.id,
    })
    expect(task).toMatchObject({
      isRequest: true,
      createdByName: 'Ada Asker',
      reviewerId: asker.id,
      canClaim: true,
    })
  })

  it("lists a chapter's requests only in that chapter, and not to whoever asked", async () => {
    const { asker, taker } = await chapterWithPeople()
    const elsewhere = await chapterWithPeople()
    const posted = await ask(asker)
    const ids = async (who: { id: number }) =>
      (await clientAs(who as never).quickTasks.available()).map((t) => t.id)
    expect(await ids(taker)).toContain(posted.id)
    expect(await ids(asker)).not.toContain(posted.id)
    expect(await ids(elsewhere.taker)).not.toContain(posted.id)

    expect(await clientAs(asker).requests.mine()).toEqual([
      expect.objectContaining({ id: posted.id, takenBy: null, global: false }),
    ])
  })

  it('lists a request with helper places once, as a request', async () => {
    const { asker, taker } = await chapterWithPeople()
    const posted = await ask(asker, 'Run a stall', { helpersWanted: 2 })
    const listed = (await clientAs(taker).quickTasks.available()).filter((t) => t.id === posted.id)
    expect(listed.map((t) => t.kind)).toEqual(['request'])
  })

  it('keeps standing projects out of the projects lists, and they never finish', async () => {
    const { lead, asker, taker } = await chapterWithPeople()
    const posted = await ask(asker)
    const list = await clientAs(taker).projects.list({})
    expect(list.projects.map((p) => p.id)).not.toContain(posted.projectId)
    const grouped = await clientAs(taker).projects.listGrouped({})
    expect(JSON.stringify(grouped)).not.toContain(`"id":${posted.projectId},`)

    await expect(
      clientAs(lead).projects.update({ id: posted.projectId, status: 'completed' }),
    ).rejects.toMatchObject({ message: 'Requests for help never finish' })
    await expect(clientAs(lead).projects.delete({ id: posted.projectId })).rejects.toMatchObject({
      message: 'Requests for help cannot be deleted',
    })
  })
})

describe('taking a request', () => {
  it('needs nobody to say yes, and tells whoever asked', async () => {
    const { asker, taker } = await chapterWithPeople()
    const posted = await ask(asker)
    const result = await clientAs(taker).projects.updateTask({
      projectId: posted.projectId,
      taskId: posted.id,
      data: { assigneeId: taker.id },
    })
    expect(result.requested).toBe(false)
    expect(await prisma.workItem.findUniqueOrThrow({ where: { id: posted.id } })).toMatchObject({
      assigneeId: taker.id,
      requestedById: null,
    })
    await vi.waitFor(async () =>
      expect(await notes(asker.id, 'request_taken')).toEqual([
        expect.objectContaining({
          title: "Tom Taker has taken your request 'Proofread the flyer'",
        }),
      ]),
    )
    expect(await clientAs(asker).requests.mine()).toEqual([
      expect.objectContaining({ id: posted.id, takenBy: { id: taker.id, name: 'Tom Taker' } }),
    ])
  })

  it('lets anyone help on it straight away, telling whoever asked', async () => {
    const { asker, taker } = await chapterWithPeople()
    const posted = await ask(asker, 'Run a stall', { helpersWanted: 2 })
    const result = await clientAs(taker).projects.expressInterest({
      projectId: posted.projectId,
      taskId: posted.id,
      interestType: 'want_to_help_task',
    })
    expect(result).toMatchObject({ requested: false })
    await vi.waitFor(async () =>
      expect(await notes(asker.id, 'request_taken')).toEqual([
        expect.objectContaining({ title: "Tom Taker is helping on your request 'Run a stall'" }),
      ]),
    )
  })

  it('tells nobody when the asker takes their own request', async () => {
    const { asker } = await chapterWithPeople()
    const posted = await ask(asker)
    await clientAs(asker).projects.updateTask({
      projectId: posted.projectId,
      taskId: posted.id,
      data: { assigneeId: asker.id },
    })
    expect(await notes(asker.id, 'request_taken')).toEqual([])
  })
})

describe('reviewing a request', () => {
  async function handedIn() {
    const people = await chapterWithPeople()
    const posted = await ask(people.asker)
    const ids = { projectId: posted.projectId, taskId: posted.id }
    await clientAs(people.taker).projects.updateTask({
      ...ids,
      data: { assigneeId: people.taker.id },
    })
    const submitted = await clientAs(people.taker).projects.submitTask({ ...ids, note: 'Done it' })
    return { ...people, ids, submitted }
  }

  it('waits for whoever asked, who is told and accepts it', async () => {
    const { asker, taker, ids, submitted } = await handedIn()
    expect(submitted.status).toBe('under_review')
    await vi.waitFor(async () => expect(await notes(asker.id, 'task_submitted')).toHaveLength(1))
    const outsider = await createMember(await createChapter())
    await expect(clientAs(outsider).projects.acceptTask(ids)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    })
    await expect(clientAs(taker).projects.acceptTask(ids)).rejects.toMatchObject({
      message: 'Only whoever asked for help, or chapter staff, can review this request',
    })
    await clientAs(asker).projects.acceptTask(ids)
    expect(await prisma.workItem.findUniqueOrThrow({ where: { id: ids.taskId } })).toMatchObject({
      status: 'completed',
      reviewedById: asker.id,
    })
  })

  it("can be done by the chapter's staff instead", async () => {
    const { lead, ids } = await handedIn()
    await clientAs(lead).projects.requestTaskChanges({ ...ids, message: 'One more pass' })
    expect(await prisma.workItem.findUniqueOrThrow({ where: { id: ids.taskId } })).toMatchObject({
      status: 'in_progress',
    })
  })

  it('is not asked of an ordinary project task’s creator', async () => {
    const { chapter, lead, taker } = await chapterWithPeople()
    const project = await createProject({
      status: 'in_progress',
      nationalChapterId: chapter.id,
      assigneeId: lead.id,
      autoAcceptTasks: false,
    })
    const task = await prisma.workItem.create({
      data: {
        type: 'TASK',
        status: 'in_progress',
        parentId: project.id,
        title: 'Plain task',
        creatorId: taker.id,
        assigneeId: lead.id,
      },
    })
    const ids = { projectId: project.id, taskId: task.id }
    await clientAs(lead).projects.submitTask({ ...ids, note: 'Done' })
    expect((await prisma.workItem.findUniqueOrThrow({ where: { id: task.id } })).status).toBe(
      'completed',
    )
    expect((await clientAs(taker).projects.getTask(ids)).reviewerId).toBe(lead.id)
  })
})
