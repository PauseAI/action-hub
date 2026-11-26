import { prisma } from '@/lib/prisma'
import { loadTaskStatusViews } from '@/lib/work-item'
import { authedProcedure } from '../procedures'
import { InterestStatus, TaskStatus, WorkItemType } from '@/generated/prisma/enums'

export const myRouter = {
  /**
   * Project tasks the volunteer leads (has claimed) or helps on and that are not handed in,
   * started or not.
   */
  projectTasks: authedProcedure.handler(async ({ context }) => {
    const me = context.volunteer.id
    const tasks = await prisma.workItem.findMany({
      where: {
        type: WorkItemType.TASK,
        status: { in: [TaskStatus.not_started, TaskStatus.in_progress] },
        OR: [
          { assigneeId: me },
          { interests: { some: { volunteerId: me, status: InterestStatus.accepted } } },
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
      ...views[i],
      updatedAt: t.updatedAt,
    }))
  }),
}
