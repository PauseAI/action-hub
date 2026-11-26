import { prisma } from '@/lib/prisma'
import { loadTaskStatusViews } from '@/lib/work-item'
import { authedProcedure } from '../procedures'
import { InterestStatus, TaskStatus, WorkItemType } from '@/generated/prisma/enums'

/** How long a finished task stays listed with the volunteer's own work. */
const DONE_SHOWN_DAYS = 30

export const myRouter = {
  /**
   * Tasks the volunteer leads (has claimed) or helps on, on any project: everything not yet
   * accepted, and what was accepted in the last month. Work sent back carries the reviewer's
   * note.
   */
  projectTasks: authedProcedure.handler(async ({ context }) => {
    const me = context.volunteer.id
    const since = new Date(Date.now() - DONE_SHOWN_DAYS * 24 * 60 * 60 * 1000)
    const tasks = await prisma.workItem.findMany({
      where: {
        type: WorkItemType.TASK,
        parentId: { not: null },
        AND: [
          {
            OR: [
              {
                status: {
                  in: [TaskStatus.not_started, TaskStatus.in_progress, TaskStatus.under_review],
                },
              },
              { status: TaskStatus.completed, completedAt: { gte: since } },
            ],
          },
          {
            OR: [
              { assigneeId: me },
              { interests: { some: { volunteerId: me, status: InterestStatus.accepted } } },
            ],
          },
        ],
      },
      include: { parent: { select: { title: true } } },
      orderBy: { updatedAt: 'asc' },
    })
    const views = await loadTaskStatusViews(tasks)

    return tasks.map((t, i) => ({
      id: t.id,
      projectId: t.parentId,
      title: t.title,
      projectTitle: t.parent?.title ?? null,
      role: t.assigneeId === me ? ('Lead' as const) : ('Helper' as const),
      status: t.status,
      changesRequested: t.changesRequestedNote,
      ...views[i],
      updatedAt: t.updatedAt,
    }))
  }),
}
