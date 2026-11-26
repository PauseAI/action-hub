import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { AskForHelpSchema } from '@/lib/schemas'
import { openRequests, requestsProjectFor } from '@/lib/requests'
import {
  applyScheduleWrite,
  CLAIM_BLOCKING_INTEREST,
  projectScopeWhere,
  resolveClaimViewers,
} from '@/lib/work-item'
import { openHelperPlaces } from '@/lib/open-helper-places'
import { TERMINAL_STATUSES, UNAPPROVED_STATUSES } from '@/lib/project-status'
import { approvedProcedure } from '../procedures'
import { TaskStatus, TaskTiming, WorkItemType } from '@/generated/prisma/enums'

export const requestsRouter = {
  /**
   * The work the caller could take now, newest first: requests for help, tasks their projects'
   * owners have featured, and tasks with helper places, each listed once. Projects that turned
   * the caller away are left out.
   */
  feed: approvedProcedure.handler(async ({ context }) => {
    const viewer = context.volunteer
    const blocked = await prisma.workItemInterest.findMany({
      where: {
        volunteerId: viewer.id,
        ...CLAIM_BLOCKING_INTEREST,
        workItem: { type: WorkItemType.PROJECT },
      },
      select: { workItemId: true },
    })
    const [requests, featured] = await Promise.all([
      openRequests(viewer),
      prisma.workItem.findMany({
        where: {
          type: WorkItemType.TASK,
          status: TaskStatus.not_started,
          assigneeId: null,
          requestedById: null,
          featuredAsQuickTask: true,
          parentId: { not: null, notIn: blocked.map((b) => b.workItemId) },
          parent: {
            standingRequests: false,
            status: { notIn: [...TERMINAL_STATUSES, ...UNAPPROVED_STATUSES] },
            AND: [projectScopeWhere({ ...viewer, isAdmin: false })],
          },
        },
        include: {
          parent: {
            select: {
              id: true,
              title: true,
              teamId: true,
              assigneeId: true,
              alwaysAskToJoin: true,
              standingRequests: true,
            },
          },
        },
        orderBy: { createdAt: 'desc' },
      }),
    ])
    const claimViewerOn = await resolveClaimViewers(
      featured.flatMap((t) => (t.parent ? [t.parent] : [])),
      viewer,
    )
    const listed = new Set([...requests, ...featured].map((t) => t.id))
    const helperPlaces = (await openHelperPlaces(viewer)).items.filter((t) => !listed.has(t.id))
    return [
      ...requests,
      ...featured.flatMap((t) =>
        t.parent
          ? [
              {
                kind: 'featured' as const,
                id: t.id,
                title: t.title,
                description: t.description,
                projectId: t.parent.id,
                projectTitle: t.parent.title,
                claimViewer: claimViewerOn(t.parent),
                estimatedHours: t.estimatedHours,
                deadline: t.deadline,
                createdAt: t.createdAt,
              },
            ]
          : [],
      ),
      ...helperPlaces,
    ].sort((a, b) => (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0))
  }),

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

  /**
   * The project and task of a request the caller can see, for /quick-tasks/:id links; null for
   * anything else.
   */
  locate: approvedProcedure
    .input(z.object({ id: z.number().int() }))
    .handler(async ({ input, context }) => {
      const task = await prisma.workItem.findFirst({
        where: {
          id: input.id,
          type: WorkItemType.TASK,
          parent: {
            standingRequests: true,
            AND: [projectScopeWhere(context.volunteer)],
          },
        },
        select: { id: true, parentId: true },
      })
      return task?.parentId ? { projectId: task.parentId, taskId: task.id } : null
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
