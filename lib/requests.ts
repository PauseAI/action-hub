import { ORPCError } from '@orpc/server'
import type { Prisma } from '@/generated/prisma/client'
import { ProjectStatus, TaskStatus, WorkItemType } from '@/generated/prisma/enums'
import { prisma } from './prisma'
import { CLAIM_BLOCKING_INTEREST } from './work-item'

/**
 * Requests for help: tasks anyone approved can ask for, held in a standing project per national
 * chapter, plus 'Global requests' for the holding pool (no chapter). A standing project is made
 * the first time someone asks there. It has no owner, never finishes, and is left out of project
 * lists; chapter staff run it as they run every project in their chapter, and each request's
 * asker reviews the work handed in on it (`requester` in lib/permissions.ts).
 */

export const GLOBAL_REQUESTS_TITLE = 'Global requests'

export function requestsProjectTitle(chapter: { name: string } | null): string {
  return chapter ? `Requests for help: ${chapter.name}` : GLOBAL_REQUESTS_TITLE
}

/** Refuses to finish, reopen or review a standing project, which never changes status. */
export function assertNotStanding(project: { standingRequests: boolean }): void {
  if (project.standingRequests) {
    throw new ORPCError('BAD_REQUEST', { message: 'Requests for help never finish' })
  }
}

/** Leaves standing projects out of a project query. */
export const NOT_STANDING = { standingRequests: false } as const

type Tx = Prisma.TransactionClient

/** The standing project for `chapterId` (null: global), made if it does not exist yet. */
export async function requestsProjectFor(tx: Tx, chapterId: number | null) {
  // Two first asks at once must not make two projects.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`requests:${chapterId ?? 'global'}`}))`
  const found = await tx.workItem.findFirst({
    where: { type: WorkItemType.PROJECT, standingRequests: true, nationalChapterId: chapterId },
    orderBy: { id: 'asc' },
  })
  if (found) return found
  const chapter =
    chapterId === null
      ? null
      : await tx.nationalChapter.findUniqueOrThrow({
          where: { id: chapterId },
          select: { name: true },
        })
  return tx.workItem.create({
    data: {
      type: WorkItemType.PROJECT,
      status: ProjectStatus.in_progress,
      standingRequests: true,
      title: requestsProjectTitle(chapter),
      description: chapter
        ? `Small things people in ${chapter.name} have asked for help with. Anyone can take one.`
        : 'Small things people anywhere have asked for help with. Anyone can take one.',
      nationalChapterId: chapterId,
      isOrgProposed: true,
      autoAcceptTasks: false,
      reviewedAt: new Date(),
      // Never planned or proposed: its tasks are asks, each whole when made.
      plannedAt: new Date(),
    },
  })
}

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
