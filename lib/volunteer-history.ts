import type { Prisma } from '@/generated/prisma/client'
import { InterestStatus, ProjectStatus, TaskStatus, WorkItemType } from '@/generated/prisma/enums'

/**
 * A volunteer's track record: each project they proposed, led, deputised on or joined, and the
 * tasks they led or helped on within it, current work first.
 */

export type ProjectRole = 'creator' | 'owner' | 'deputy' | 'member'
export type TaskRole = 'assignee' | 'helper'

export type RoleStint<R> = {
  role: R
  /** When they took it on, where that was recorded. */
  since: Date | null
  /** They left or were taken off; the work itself may carry on. */
  ended: boolean
}

export type TaskHistoryEntry = RoleStint<TaskRole> & {
  id: number
  title: string
  status: string
  completedAt: Date | null
  current: boolean
}

export type ProjectHistoryEntry = {
  id: number
  title: string
  status: string
  completedAt: Date | null
  current: boolean
  roles: RoleStint<ProjectRole>[]
  tasks: TaskHistoryEntry[]
}

const ROLE_ORDER: ProjectRole[] = ['owner', 'deputy', 'member', 'creator']

/**
 * Whose history is read, and whether the reader may see the parts they left or were taken off.
 * The project page shows those only to people who can recruit on it, so a profile shows them
 * only to the volunteer themselves and their chapter's staff.
 */
export type HistoryScope = { volunteerId: number; seesEnded: boolean }

// On it now, or (when the reader may see it) was until they left or were taken off. Only an
// accepted interest has a response recorded before it is withdrawn; a withdrawn application has
// none.
const joinedWhere = ({
  volunteerId,
  seesEnded,
}: HistoryScope): Prisma.WorkItemInterestWhereInput =>
  seesEnded
    ? {
        volunteerId,
        OR: [
          { status: { in: [InterestStatus.accepted, InterestStatus.removed] } },
          { status: InterestStatus.withdrawn, respondedAt: { not: null } },
        ],
      }
    : { volunteerId, status: InterestStatus.accepted }

// An accepted bid to own makes them a member while someone else owns the project.
const MEMBER_TYPES = ['want_to_contribute', 'want_to_own']

const memberWhere = (scope: HistoryScope): Prisma.WorkItemInterestWhereInput => ({
  ...joinedWhere(scope),
  interestType: { in: MEMBER_TYPES },
})

const helperWhere = (scope: HistoryScope): Prisma.WorkItemInterestWhereInput => ({
  ...joinedWhere(scope),
  interestType: 'want_to_help_task',
})

const taskWhere = (scope: HistoryScope): Prisma.WorkItemWhereInput => ({
  type: WorkItemType.TASK,
  OR: [{ assigneeId: scope.volunteerId }, { interests: { some: helperWhere(scope) } }],
})

/** Projects the volunteer has held any role on, or led or helped on a task in. */
export const historyWhere = (scope: HistoryScope): Prisma.WorkItemWhereInput => ({
  type: WorkItemType.PROJECT,
  OR: [
    { creatorId: scope.volunteerId },
    { assigneeId: scope.volunteerId },
    { deputies: { some: { volunteerId: scope.volunteerId } } },
    { interests: { some: memberWhere(scope) } },
    { children: { some: taskWhere(scope) } },
  ],
})

const stintSelect = { status: true, interestType: true, createdAt: true, respondedAt: true }

export const historySelect = (scope: HistoryScope) =>
  ({
    id: true,
    title: true,
    status: true,
    creatorId: true,
    assigneeId: true,
    createdAt: true,
    completedAt: true,
    deputies: { where: { volunteerId: scope.volunteerId }, select: { createdAt: true } },
    interests: { where: memberWhere(scope), select: stintSelect },
    children: {
      where: taskWhere(scope),
      orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        title: true,
        status: true,
        assigneeId: true,
        claimedAt: true,
        completedAt: true,
        interests: { where: helperWhere(scope), select: stintSelect },
      },
    },
  }) satisfies Prisma.WorkItemSelect

type Stint = {
  status: string
  interestType: string
  createdAt: Date | null
  respondedAt: Date | null
}

export type HistoryRow = {
  id: number
  title: string
  status: string
  creatorId: number | null
  assigneeId: number | null
  createdAt: Date | null
  completedAt: Date | null
  deputies: { createdAt: Date }[]
  interests: Stint[]
  children: {
    id: number
    title: string
    status: string
    assigneeId: number | null
    claimedAt: Date | null
    completedAt: Date | null
    interests: Stint[]
  }[]
}

const ended = (s: Stint) => s.status !== InterestStatus.accepted

// Leaving or being taken off overwrites respondedAt, so an ended stint has no start date left.
const joined = (s: Stint) => (ended(s) ? null : (s.respondedAt ?? s.createdAt))

function projectRoles(row: HistoryRow, volunteerId: number): RoleStint<ProjectRole>[] {
  const roles: RoleStint<ProjectRole>[] = []
  // One interest row per volunteer and project: a bid to own or to contribute.
  const bid = row.interests[0]
  if (row.creatorId === volunteerId) {
    roles.push({ role: 'creator', since: row.createdAt, ended: false })
  }
  if (row.assigneeId === volunteerId) {
    const offer = bid?.interestType === 'want_to_own' ? bid : undefined
    const since = offer ? joined(offer) : row.creatorId === volunteerId ? row.createdAt : null
    roles.push({ role: 'owner', since, ended: false })
  }
  const deputy = row.deputies[0]
  if (deputy) roles.push({ role: 'deputy', since: deputy.createdAt, ended: false })
  // An owner or deputy is a member too; the larger role says so.
  if (bid && !roles.some((r) => r.role !== 'creator')) {
    roles.push({ role: 'member', since: joined(bid), ended: ended(bid) })
  }
  return roles.sort((a, b) => ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role))
}

function taskEntries(row: HistoryRow, volunteerId: number): TaskHistoryEntry[] {
  const live = row.status !== ProjectStatus.completed
  return row.children.flatMap((t): TaskHistoryEntry[] => {
    const open = live && t.status !== TaskStatus.completed
    const base = { id: t.id, title: t.title, status: t.status, completedAt: t.completedAt }
    if (t.assigneeId === volunteerId) {
      return [{ ...base, role: 'assignee', since: t.claimedAt, ended: false, current: open }]
    }
    // The task and its helpers load in separate queries, so a helper who left in between is gone.
    const helping = t.interests[0]
    if (!helping) return []
    // Done work keeps its helpers; taken off or leaving before then ends their part.
    const gone = ended(helping)
    return [
      { ...base, role: 'helper', since: joined(helping), ended: gone, current: open && !gone },
    ]
  })
}

/** When the volunteer last did anything recorded on the project, for ordering past work. */
function lastActive(entry: ProjectHistoryEntry): number {
  const dates = [
    entry.completedAt,
    ...entry.roles.map((r) => r.since),
    ...entry.tasks.flatMap((t) => [t.since, t.completedAt]),
  ]
  return Math.max(0, ...dates.map((d) => d?.getTime() ?? 0))
}

/**
 * Each project's roles and tasks for `volunteerId`, current work first, then the most recent.
 * A project stays current while it is unfinished and they hold any part in it.
 */
export function projectHistory(rows: HistoryRow[], volunteerId: number): ProjectHistoryEntry[] {
  const entries = rows.map((row): ProjectHistoryEntry => {
    const roles = projectRoles(row, volunteerId)
    const tasks = taskEntries(row, volunteerId)
    // Proposing a project is done once it is proposed; it keeps no one on it.
    const holdsPart =
      roles.some((r) => r.role !== 'creator' && !r.ended) || tasks.some((t) => t.current)
    return {
      id: row.id,
      title: row.title,
      status: row.status,
      completedAt: row.completedAt,
      current: row.status !== ProjectStatus.completed && holdsPart,
      roles,
      tasks,
    }
  })
  return entries.sort(
    (a, b) => Number(b.current) - Number(a.current) || lastActive(b) - lastActive(a),
  )
}
