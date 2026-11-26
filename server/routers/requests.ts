import { prisma } from '@/lib/prisma'
import { AskForHelpSchema } from '@/lib/schemas'
import { requestsProjectFor } from '@/lib/requests'
import { applyScheduleWrite, CLAIM_BLOCKING_INTEREST } from '@/lib/work-item'
import { approvedProcedure } from '../procedures'
import { TaskStatus, TaskTiming, WorkItemType } from '@/generated/prisma/enums'

export type OpenRequest = {
  kind: 'request'
  id: number
  title: string
  description: string | null
  projectId: number
  projectTitle: string
  askedBy: { id: number; name: string } | null
  global: boolean
  helpersWanted: number | null
  estimatedHours: number | null
  deadline: Date | null
  createdAt: Date | null
}

/**
 * Requests for help nobody has taken yet that `viewer` could take: in their chapter's standing
 * project or the global one, not their own, and not on a project that turned them away.
 */
export async function openRequests(viewer: {
  id: number
  nationalChapterId: number | null
}): Promise<OpenRequest[]> {
  const tasks = await prisma.workItem.findMany({
    where: {
      type: WorkItemType.TASK,
      status: TaskStatus.not_started,
      assigneeId: null,
      requestedById: null,
      OR: [{ creatorId: null }, { creatorId: { not: viewer.id } }],
      parent: {
        standingRequests: true,
        OR: [{ nationalChapterId: viewer.nationalChapterId }, { nationalChapterId: null }],
        interests: { none: { volunteerId: viewer.id, ...CLAIM_BLOCKING_INTEREST } },
      },
    },
    include: {
      creator: { select: { id: true, name: true } },
      parent: { select: { id: true, title: true, nationalChapterId: true } },
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
  })
  return tasks.flatMap((t) =>
    t.parent
      ? [
          {
            kind: 'request' as const,
            id: t.id,
            title: t.title,
            description: t.description,
            projectId: t.parent.id,
            projectTitle: t.parent.title,
            askedBy: t.creator,
            global: t.parent.nationalChapterId === null,
            helpersWanted: t.helpersWanted,
            estimatedHours: t.estimatedHours,
            deadline: t.deadline,
            createdAt: t.createdAt,
          },
        ]
      : [],
  )
}

export const requestsRouter = {
  /**
   * Asks for help: a task in the asker's chapter's Requests for help project, or the global one.
   * Anyone approved may ask, and reviews the work handed in on it.
   */
  ask: approvedProcedure.input(AskForHelpSchema).handler(async ({ input, context }) => {
    const volunteer = context.volunteer
    // Someone in the holding pool has no chapter of their own to ask.
    const chapterId = input.global ? null : volunteer.nationalChapterId
    const schedule: Record<string, unknown> = {}
    applyScheduleWrite(schedule, {
      startDate: null,
      durationDays: null,
      taskDeadline: input.deadline ?? null,
    })
    return prisma.$transaction(async (tx) => {
      const project = await requestsProjectFor(tx, chapterId)
      const max = await tx.workItem.aggregate({
        where: { parentId: project.id, type: WorkItemType.TASK },
        _max: { sortOrder: true },
      })
      const created = await tx.workItem.create({
        data: {
          type: WorkItemType.TASK,
          status: TaskStatus.not_started,
          parentId: project.id,
          title: input.title,
          description: input.description ?? null,
          estimatedHours: input.estimatedHours ?? null,
          helpersWanted: input.helpersWanted ?? null,
          submissionPrompt: input.submissionPrompt ?? null,
          submissionAsksLink: input.submissionAsksLink ?? false,
          timing: TaskTiming.flexible,
          creatorId: volunteer.id,
          sortOrder: (max._max.sortOrder ?? 0) + 1,
          ...schedule,
        },
      })
      return { id: created.id, projectId: project.id, message: 'Request posted' }
    })
  }),

  /** The requests for help the caller has asked for, newest first, done ones included. */
  mine: approvedProcedure.handler(async ({ context }) => {
    const tasks = await prisma.workItem.findMany({
      where: {
        type: WorkItemType.TASK,
        creatorId: context.volunteer.id,
        parent: { standingRequests: true },
      },
      include: {
        assignee: { select: { id: true, name: true } },
        parent: { select: { id: true, nationalChapterId: true } },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    })
    return tasks.flatMap((t) =>
      t.parent
        ? [
            {
              id: t.id,
              projectId: t.parent.id,
              title: t.title,
              description: t.description,
              status: t.status,
              global: t.parent.nationalChapterId === null,
              takenBy: t.assignee,
              deadline: t.deadline,
              createdAt: t.createdAt,
            },
          ]
        : [],
    )
  }),
}
