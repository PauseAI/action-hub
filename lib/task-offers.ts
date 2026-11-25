import { InterestOrigin, InterestStatus, TaskStatus, WorkItemType } from '@/generated/prisma/enums'
import type { Prisma } from '@/generated/prisma/client'
import { prisma } from './prisma'
import { TASK_HELPER } from './task-helpers'
import { recordEvent } from './work-item-events'
import { clearNotifications, notifyUser } from './notify'

/**
 * Someone not yet on a project offers to help on one of its tasks: a `pending` helper row on the
 * task, which waits on their request to join the project (a `pending` want_to_contribute row on
 * the project). Accepting the request puts them on both; declining or withdrawing drops both.
 * An offer whose task fills first is closed as `declined` with this answer.
 */
export const PLACE_FILLED = 'Place filled'

type Tx = Prisma.TransactionClient

/** Holds the task row so two people taking the last helper place cannot both get it. */
export async function lockTask(tx: Tx, taskId: number): Promise<void> {
  await tx.$queryRaw`SELECT id FROM work_items WHERE id = ${taskId} FOR UPDATE`
}

/** Helper places still open on a task, read under `lockTask`. */
export async function openPlaces(tx: Tx, task: { id: number; helpersWanted: number }) {
  const helping = await tx.workItemInterest.count({
    where: { workItemId: task.id, status: InterestStatus.accepted },
  })
  return task.helpersWanted - helping
}

/** A task still taking helpers: not handed in, not done, and asking for some. */
function takesHelpers<T extends { status: string; helpersWanted: number | null }>(
  task: T,
): task is T & { helpersWanted: number } {
  return (
    task.helpersWanted !== null &&
    task.status !== TaskStatus.under_review &&
    task.status !== TaskStatus.completed
  )
}

const pendingOffersOn = (projectId: number, volunteerId: number) => ({
  volunteerId,
  interestType: TASK_HELPER,
  status: InterestStatus.pending,
  workItem: { parentId: projectId, type: WorkItemType.TASK },
})

async function tellPlaceFilled(
  task: { id: number; title: string; parentId: number | null },
  to: number,
) {
  await notifyUser(
    to,
    'helper_place_filled',
    `Place filled: '${task.title}' is not taking more helpers`,
    null,
    `/projects/${task.parentId}/tasks/${task.id}`,
    undefined,
    task.id,
  )
}

/**
 * Closes a pending request to join the project once nothing is left of it: no task held for
 * them and no offer to help still waiting. Returns whether it did.
 */
export async function dropEmptyRequest(projectId: number, volunteerId: number): Promise<boolean> {
  const [held, offers] = await Promise.all([
    prisma.workItem.count({
      where: { parentId: projectId, type: WorkItemType.TASK, requestedById: volunteerId },
    }),
    prisma.workItemInterest.count({ where: pendingOffersOn(projectId, volunteerId) }),
  ])
  if (held > 0 || offers > 0) return false
  const request = await prisma.workItemInterest.findFirst({
    where: {
      workItemId: projectId,
      volunteerId,
      status: InterestStatus.pending,
      interestType: 'want_to_contribute',
    },
  })
  if (!request) return false
  await prisma.workItemInterest.update({
    where: { id: request.id },
    data: { status: InterestStatus.withdrawn, respondedAt: new Date() },
  })
  await clearNotifications('new_interest', request.id)
  return true
}

/**
 * Once a task has all the helpers it wants, or stops taking any (handed in, done, or seeking
 * none), closes the offers still waiting on it as filled, tells each person, and drops their
 * request to join if that was all it asked for.
 */
export async function closeOffersOnFullTask(projectId: number, taskId: number): Promise<void> {
  const task = await prisma.workItem.findUniqueOrThrow({ where: { id: taskId } })
  const closed = await prisma.$transaction(async (tx) => {
    await lockTask(tx, taskId)
    if (takesHelpers(task) && (await openPlaces(tx, task)) > 0) return []
    const waiting = await tx.workItemInterest.findMany({
      where: { workItemId: taskId, interestType: TASK_HELPER, status: InterestStatus.pending },
      select: { id: true, volunteerId: true },
    })
    await tx.workItemInterest.updateMany({
      where: { id: { in: waiting.map((w) => w.id) } },
      data: {
        status: InterestStatus.declined,
        responseMessage: PLACE_FILLED,
        respondedAt: new Date(),
      },
    })
    return waiting.map((w) => w.volunteerId)
  })
  for (const volunteerId of closed) {
    await tellPlaceFilled(task, volunteerId)
    await dropEmptyRequest(projectId, volunteerId)
  }
}

/**
 * Someone just accepted onto the project takes the helper places they offered for, first come
 * first served: an offer whose task filled meanwhile, or stopped taking helpers, is closed as
 * filled and they are told.
 */
export async function acceptHelperOffers(
  projectId: number,
  volunteerId: number,
  actorId: number,
): Promise<void> {
  const offers = await prisma.workItemInterest.findMany({
    where: pendingOffersOn(projectId, volunteerId),
    include: { workItem: true },
    orderBy: { id: 'asc' },
  })
  for (const offer of offers) {
    const task = offer.workItem
    const joined = await prisma.$transaction(async (tx) => {
      await lockTask(tx, task.id)
      const current = await tx.workItem.findUniqueOrThrow({ where: { id: task.id } })
      const room =
        takesHelpers(current) &&
        current.assigneeId !== volunteerId &&
        (await openPlaces(tx, current)) > 0
      await tx.workItemInterest.update({
        where: { id: offer.id },
        data: room
          ? { status: InterestStatus.accepted, respondedAt: new Date() }
          : {
              status: InterestStatus.declined,
              responseMessage: PLACE_FILLED,
              respondedAt: new Date(),
            },
      })
      if (room) {
        await recordEvent(tx, {
          workItemId: task.id,
          actorId,
          kind: 'helper_added',
          before: {},
          after: { helperId: volunteerId },
        })
      }
      return room
    })
    if (joined) await closeOffersOnFullTask(projectId, task.id)
    else await tellPlaceFilled(task, volunteerId)
  }
}

/**
 * Ends someone's offers to help on a project's tasks: `withdrawn` when they took the request
 * back, `declined` when the owner turned it down.
 */
export async function endHelperOffers(
  projectId: number,
  volunteerId: number,
  status: typeof InterestStatus.withdrawn | typeof InterestStatus.declined,
): Promise<void> {
  await prisma.workItemInterest.updateMany({
    where: pendingOffersOn(projectId, volunteerId),
    data: { status, respondedAt: new Date() },
  })
}

/**
 * Makes `volunteerId` a member of the project when a manager puts them on one of its tasks, or
 * they take one on fast track.
 * A pending request is accepted as it stands, without the lead it may have offered; any other
 * past row, or none, is a fresh add. Someone already on it is left as they are.
 */
export async function addToProject(
  projectId: number,
  volunteerId: number,
  message: string | null,
  // `applied` when they joined themselves, on fast track.
  origin: InterestOrigin = InterestOrigin.added,
): Promise<void> {
  const existing = await prisma.workItemInterest.findFirst({
    where: { workItemId: projectId, volunteerId },
  })
  const now = new Date()
  const member = {
    status: InterestStatus.accepted,
    interestType: 'want_to_contribute',
    respondedAt: now,
  }
  if (!existing) {
    await prisma.workItemInterest.create({
      data: {
        ...member,
        volunteerId,
        workItemId: projectId,
        origin,
        message,
      },
    })
    return
  }
  await prisma.workItemInterest.updateMany({
    where: { id: existing.id, status: { not: InterestStatus.accepted } },
    data:
      existing.status === InterestStatus.pending
        ? member
        : { ...member, origin, responseMessage: null },
  })
  const answered: Record<string, string> = {
    [InterestStatus.invited]: 'project_invite',
    [InterestStatus.pending]: 'new_interest',
  }
  if (answered[existing.status]) await clearNotifications(answered[existing.status], existing.id)
}
