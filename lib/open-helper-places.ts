import { InterestStatus, TaskStatus, WorkItemType } from '@/generated/prisma/enums'
import { prisma } from './prisma'
import { CLAIM_BLOCKING_INTEREST, projectScopeWhere, resolveClaimViewers } from './work-item'
import { TERMINAL_STATUSES, UNAPPROVED_STATUSES } from './project-status'
import type { ClaimViewer } from './action-labels'

/**
 * A task with a helper place someone could take now: one item of the list of work open to a
 * volunteer, which Quick Tasks and the Home page show beside other kinds (`kind` tells them
 * apart).
 */
export type OpenHelperPlace = {
  kind: 'helper_place'
  id: number
  title: string
  description: string | null
  status: string
  projectId: number
  projectTitle: string
  /** Who is asking for help: the task's lead, else the project's owner. */
  askedBy: { id: number; name: string } | null
  placesLeft: number
  /** People waiting to join the project who have offered for these places already. */
  offeredBy: { id: number; name: string }[]
  claimViewer: ClaimViewer
  estimatedHours: number | null
  deadline: Date | null
  createdAt: Date | null
}

type Viewer = {
  id: number
  nationalChapterId: number | null
  isAdmin?: boolean | null
}

/**
 * Tasks in projects `viewer` can see that still want helpers, newest first: not handed in or
 * done, on a live project they do not run and that has not turned them away, and not ones they
 * lead, help on or have offered for already.
 */
export async function openHelperPlaces(
  viewer: Viewer,
  { limit }: { limit?: number } = {},
): Promise<{ items: OpenHelperPlace[]; total: number }> {
  const blocked = await prisma.workItemInterest.findMany({
    where: {
      volunteerId: viewer.id,
      ...CLAIM_BLOCKING_INTEREST,
      workItem: { type: WorkItemType.PROJECT },
    },
    select: { workItemId: true },
  })
  const tasks = await prisma.workItem.findMany({
    where: {
      type: WorkItemType.TASK,
      helpersWanted: { not: null },
      status: { in: [TaskStatus.not_started, TaskStatus.in_progress] },
      parentId: { not: null, notIn: blocked.map((b) => b.workItemId) },
      // Spelled out with nulls, since `NOT` of a comparison with NULL matches nothing.
      AND: [
        { OR: [{ assigneeId: null }, { assigneeId: { not: viewer.id } }] },
        { OR: [{ requestedById: null }, { requestedById: { not: viewer.id } }] },
      ],
      interests: { none: { volunteerId: viewer.id, status: { not: InterestStatus.withdrawn } } },
      parent: {
        status: { notIn: [...TERMINAL_STATUSES, ...UNAPPROVED_STATUSES] },
        AND: [
          projectScopeWhere({ ...viewer, isAdmin: false }),
          // Not the projects they run: there they add helpers rather than offer.
          { OR: [{ assigneeId: null }, { assigneeId: { not: viewer.id } }] },
          { deputies: { none: { volunteerId: viewer.id } } },
        ],
      },
    },
    include: {
      assignee: { select: { id: true, name: true } },
      parent: {
        select: {
          id: true,
          title: true,
          teamId: true,
          assigneeId: true,
          alwaysAskToJoin: true,
          assignee: { select: { id: true, name: true } },
        },
      },
      interests: {
        where: { status: { in: [InterestStatus.accepted, InterestStatus.pending] } },
        select: { status: true, volunteer: { select: { id: true, name: true } } },
        orderBy: { id: 'asc' },
      },
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
  })
  const open = tasks.flatMap((t) => {
    const helping = t.interests.filter((i) => i.status === InterestStatus.accepted).length
    const placesLeft = (t.helpersWanted ?? 0) - helping
    return placesLeft > 0 && t.parent ? [{ task: t, parent: t.parent, placesLeft }] : []
  })
  const shown = limit === undefined ? open : open.slice(0, limit)
  const claimViewerOn = await resolveClaimViewers(
    shown.map((o) => o.parent),
    viewer,
  )
  return {
    total: open.length,
    items: shown.map(({ task, parent, placesLeft }) => ({
      kind: 'helper_place' as const,
      id: task.id,
      title: task.title,
      description: task.description,
      status: task.status,
      projectId: parent.id,
      projectTitle: parent.title,
      askedBy: task.assignee ?? parent.assignee,
      placesLeft,
      offeredBy: task.interests
        .filter((i) => i.status === InterestStatus.pending)
        .map((i) => i.volunteer),
      claimViewer: claimViewerOn(parent),
      estimatedHours: task.estimatedHours,
      deadline: task.deadline,
      createdAt: task.createdAt,
    })),
  }
}
