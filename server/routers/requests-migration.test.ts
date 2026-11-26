import { describe, it, expect, vi } from 'vitest'
import { readFileSync, readdirSync } from 'fs'
import { join } from 'path'
import { prisma } from '@/lib/prisma'
import {
  createAdmin,
  createChapter,
  createChapterLead,
  createMember,
  createQuickTask,
  createSkill,
} from '@/test/factories'
import { clientAs } from '@/test/rpc'

const dir = join(process.cwd(), 'prisma', 'migrations')
const sql = readFileSync(
  join(dir, readdirSync(dir).find((d) => d.endsWith('_quick_tasks_to_requests'))!, 'migration.sql'),
  'utf8',
)

/** Runs the migration again, on whatever the test has put in the database. */
async function migrate() {
  for (const statement of sql.split(/;\s*$/m).filter((s) => s.trim())) {
    await prisma.$executeRawUnsafe(statement)
  }
}

const standingProjects = (chapterId: number | null) =>
  prisma.workItem.findMany({
    where: { type: 'PROJECT', standingRequests: true, nationalChapterId: chapterId },
  })
const globalProjects = () => standingProjects(null)

describe('moving quick tasks into Requests for help', () => {
  it("makes each one a task in its chapter's project, field for field, keeping its endorsement", async () => {
    const chapter = await createChapter()
    const doer = await createMember(chapter, { name: 'Dee Doer' })
    const admin = await createAdmin()
    const skill = await createSkill()
    const open = await createQuickTask({
      title: 'Open one',
      nationalChapterId: chapter.id,
      estimatedHours: 2,
      deadline: new Date('2099-01-02T00:00:00Z'),
      skillId: skill.id,
      submissionPrompt: 'Link the doc',
      submissionAsksLink: true,
    })
    const claimed = await createQuickTask({
      title: 'Claimed one',
      status: 'in_progress',
      assigneeId: doer.id,
      nationalChapterId: chapter.id,
      updatedAt: new Date('2026-11-01T00:00:00Z'),
    })
    const done = await createQuickTask({
      title: 'Done one',
      nationalChapterId: chapter.id,
      status: 'completed',
      assigneeId: doer.id,
      skillId: skill.id,
      reviewedById: admin.id,
      reviewRating: 'excellent',
      submissionNote: 'Did it',
      completedAt: new Date('2026-10-01T00:00:00Z'),
    })
    const endorsement = await prisma.skillEndorsement.create({
      data: {
        volunteerId: doer.id,
        skillId: skill.id,
        endorsedById: admin.id,
        source: 'quick_task',
        sourceId: done.id,
      },
    })

    await migrate()

    const [project] = await standingProjects(chapter.id)
    expect(project).toMatchObject({
      title: `Requests for help: ${chapter.name}`,
      status: 'in_progress',
      assigneeId: null,
      autoAcceptTasks: false,
    })
    const row = (id: number) => prisma.workItem.findUniqueOrThrow({ where: { id } })
    expect(await row(open.id)).toMatchObject({
      type: 'TASK',
      parentId: project.id,
      status: 'not_started',
      nationalChapterId: null,
      estimatedHours: 2,
      deadline: new Date('2099-01-02T00:00:00Z'),
      skillId: skill.id,
      submissionPrompt: 'Link the doc',
      submissionAsksLink: true,
      claimedAt: null,
    })
    const claimedRow = await row(claimed.id)
    expect(claimedRow).toMatchObject({
      status: 'in_progress',
      assigneeId: doer.id,
      claimedAt: new Date('2026-11-01T00:00:00Z'),
    })
    // Inactivity counts from the move, so an old claim is not warned at once.
    expect(claimedRow.updatedAt!.getTime()).toBeGreaterThan(Date.now() - 60_000)
    expect(await row(done.id)).toMatchObject({
      status: 'completed',
      reviewRating: 'excellent',
      reviewedById: admin.id,
      submissionNote: 'Did it',
    })
    expect(
      await prisma.skillEndorsement.findUniqueOrThrow({ where: { id: endorsement.id } }),
    ).toMatchObject({ source: 'quick_task', sourceId: done.id })
    const order = await prisma.workItem.findMany({
      where: { parentId: project.id },
      orderBy: { sortOrder: 'asc' },
      select: { id: true },
    })
    expect(order.map((t) => t.id)).toEqual([open.id, claimed.id, done.id])

    // Anyone in the chapter can now take the open one, and old links find it.
    const someone = await createMember(chapter)
    expect((await clientAs(someone).requests.feed()).map((t) => t.id)).toContain(open.id)
    expect(await clientAs(someone).requests.locate({ id: open.id })).toEqual({
      projectId: project.id,
      taskId: open.id,
    })
    const outsider = await createMember(await createChapter())
    expect(await clientAs(outsider).requests.locate({ id: open.id })).toBeNull()

    // Its record still shows on the profile, and to staff.
    const profile = await clientAs(someone).volunteers.getById({ id: doer.id })
    expect(profile.completedTasks).toEqual([
      expect.objectContaining({ title: 'Done one', reviewRating: 'excellent' }),
    ])
    const detail = await clientAs(admin).admin.volunteers.getById({ id: doer.id })
    expect(detail.quickTasks.map((t) => t.title).sort()).toEqual(['Claimed one', 'Done one'])
  })

  it('adds to the Global requests project there is, and makes none with nothing to move', async () => {
    const before = await globalProjects()
    await migrate()
    expect(await globalProjects()).toEqual(before)

    const asker = await createMember(await createChapter())
    const asked = await clientAs(asker).requests.ask({ title: 'Asked first', global: true })
    const quick = await createQuickTask({ title: 'Moved later' })
    await migrate()
    expect((await globalProjects()).map((p) => p.id)).toEqual([asked.projectId])
    const [first, moved] = await Promise.all(
      [asked.id, quick.id].map((id) => prisma.workItem.findUniqueOrThrow({ where: { id } })),
    )
    expect(moved.parentId).toBe(asked.projectId)
    expect(moved.sortOrder).toBe((first.sortOrder ?? 0) + 1)
  })

  it('moves a quick task from the holding pool into Global requests', async () => {
    const quick = await createQuickTask({ title: 'Pooled' })
    await migrate()
    const [global] = await globalProjects()
    expect(global.title).toBe('Global requests')
    expect((await prisma.workItem.findUniqueOrThrow({ where: { id: quick.id } })).parentId).toBe(
      global.id,
    )
  })

  it('waits for chapter staff to review one handed in, since nobody asked for it', async () => {
    const chapter = await createChapter()
    const lead = await createChapterLead(chapter)
    const doer = await createMember(chapter)
    const quick = await createQuickTask({ nationalChapterId: chapter.id, title: 'No asker' })
    await migrate()
    const moved = await prisma.workItem.findUniqueOrThrow({ where: { id: quick.id } })
    const ids = { projectId: moved.parentId!, taskId: moved.id }
    await clientAs(doer).projects.updateTask({ ...ids, data: { assigneeId: doer.id } })
    const submitted = await clientAs(doer).projects.submitTask({ ...ids, note: 'Done' })
    expect(submitted.status).toBe('under_review')
    await vi.waitFor(async () =>
      expect(
        await prisma.notification.count({
          where: { volunteerId: lead.id, type: 'task_submitted' },
        }),
      ).toBe(1),
    )
    await clientAs(lead).projects.acceptTask(ids)
  })

  it('finds nothing to redirect to for anything but a request', async () => {
    const asker = await createMember(await createChapter())
    const quick = await createQuickTask()
    expect(await clientAs(asker).requests.locate({ id: quick.id })).toBeNull()
  })
})
