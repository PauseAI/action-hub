import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'fs'
import { join } from 'path'
import { prisma } from '@/lib/prisma'
import {
  createAdmin,
  createChapter,
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

const globalProjects = () =>
  prisma.workItem.findMany({
    where: { type: 'PROJECT', standingRequests: true, nationalChapterId: null },
  })

describe('moving quick tasks into Global requests', () => {
  it('makes each one a task there, field for field, keeping its endorsement', async () => {
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

    const [project] = await globalProjects()
    expect(project).toMatchObject({
      title: 'Global requests',
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
    expect(await row(claimed.id)).toMatchObject({
      status: 'in_progress',
      assigneeId: doer.id,
      claimedAt: new Date('2026-11-01T00:00:00Z'),
    })
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

    // Anyone can now take the open one, and old links find it.
    const someone = await createMember(await createChapter())
    expect((await clientAs(someone).quickTasks.available()).map((t) => t.id)).toContain(open.id)
    expect(await clientAs(someone).requests.locate({ id: open.id })).toEqual({
      projectId: project.id,
      taskId: open.id,
    })
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

  it('finds nothing to redirect to for anything but a request', async () => {
    const asker = await createMember(await createChapter())
    const quick = await createQuickTask()
    expect(await clientAs(asker).requests.locate({ id: quick.id })).toBeNull()
  })
})
