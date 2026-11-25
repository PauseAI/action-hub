import { TaskStatus, WorkItemType } from '@/generated/prisma/enums'
import { prisma } from './prisma'
import { clearNotifications, notifyChapterStaff } from './notify'
import { html } from './email'
import { isStaff } from './chapter-access'
import { loadAccess } from './chapter-access-server'
import { plural } from './plural'

/**
 * Fast track: a volunteer their chapter's staff (global admins, for someone with no chapter) have
 * marked, by hand, as able to start tasks and helper places on any project straight away, joining
 * it as they do, instead of waiting for its owner to accept them. The owner is told after the
 * fact, and a project can ask for everyone to wait regardless (`alwaysAskToJoin`). It is shown to
 * the volunteer and those staff only, never as a ranking.
 */

/** How many more accepted tasks pass before staff are asked again after "Not now". */
export const FAST_TRACK_ASK_EVERY = 3

/** What "Not now" tells whoever pressed it. */
export const NOT_NOW_MESSAGE = `Not now. You'll be asked again after ${plural(FAST_TRACK_ASK_EVERY, 'more task')}.`

/** The notification that asks staff whether to put someone on fast track. */
export const FAST_TRACK_SUGGESTED = 'fast_track_suggested'

/**
 * Project tasks the volunteer handed in themselves that have since been accepted, and are done,
 * on projects they do not own (an owner's own work needs nobody's approval). The migration that
 * added `fast_track_next_ask_at` counts the same way.
 */
export async function acceptedTaskCount(volunteerId: number): Promise<number> {
  const rows = await prisma.workItemEvent.findMany({
    where: {
      actorId: volunteerId,
      kind: 'submitted',
      workItem: {
        type: WorkItemType.TASK,
        assigneeId: volunteerId,
        status: TaskStatus.completed,
        parent: { OR: [{ assigneeId: null }, { assigneeId: { not: volunteerId } }] },
      },
    },
    distinct: ['workItemId'],
    select: { workItemId: true },
  })
  return rows.length
}

/**
 * Once a volunteer's accepted tasks reach the next mark, asks their chapter's staff (global
 * admins, for someone with no chapter) whether to put them on fast track, and moves the mark on.
 */
export async function suggestFastTrack(volunteerId: number): Promise<void> {
  const volunteer = await prisma.volunteer.findFirst({
    where: { id: volunteerId, deletedAt: null, fastTrack: false },
    select: {
      id: true,
      name: true,
      email: true,
      emailConfirmed: true,
      isAdmin: true,
      nationalChapterId: true,
      fastTrackNextAskAt: true,
    },
  })
  if (!volunteer) return
  // Staff and admins already take tasks without asking; nobody is asked about them.
  const access = await loadAccess(volunteer)
  if (access.globalAdmin || isStaff(access)) return
  const count = await acceptedTaskCount(volunteerId)
  if (count < volunteer.fastTrackNextAskAt) return
  // Only the update that still sees the old mark asks, so two acceptances at once ask once.
  const moved = await prisma.volunteer.updateMany({
    where: { id: volunteerId, fastTrackNextAskAt: volunteer.fastTrackNextAskAt },
    data: { fastTrackNextAskAt: count + FAST_TRACK_ASK_EVERY },
  })
  if (moved.count === 0) return
  // A newer ask replaces one still unanswered.
  await clearNotifications(FAST_TRACK_SUGGESTED, volunteerId)
  const { name } = volunteer
  await notifyChapterStaff(
    volunteer.nationalChapterId,
    FAST_TRACK_SUGGESTED,
    `${name} has had ${count} tasks submitted and accepted`,
    `Put ${name} on fast track, so they can start tasks straight away without waiting for approval?`,
    `/volunteers/${volunteerId}`,
    {
      subject: `Put ${name} on fast track?`,
      message: html`<strong>${name}</strong> has had ${count} tasks submitted and accepted. Put them
        on fast track, so they can start tasks straight away without waiting for approval?`,
      ctaLabel: `Fast track ${name}`,
      ctaUrl: `/volunteers/${volunteerId}`,
    },
    volunteerId,
  )
}

/** Puts a volunteer on fast track, or takes them off; either answers any ask about them. */
export async function setFastTrack(
  volunteerId: number,
  on: boolean,
  actorId: number,
): Promise<void> {
  await prisma.volunteer.update({
    where: { id: volunteerId },
    data: {
      fastTrack: on,
      fastTrackSetAt: new Date(),
      fastTrackSetById: actorId,
      // Taken off, they are not asked about again until three more tasks are accepted.
      ...(on
        ? {}
        : { fastTrackNextAskAt: (await acceptedTaskCount(volunteerId)) + FAST_TRACK_ASK_EVERY }),
    },
  })
  await clearNotifications(FAST_TRACK_SUGGESTED, volunteerId)
}

/** "Not now": the ask goes for everyone it reached, and comes back after three more tasks. */
export async function dismissFastTrack(volunteerId: number): Promise<void> {
  await clearNotifications(FAST_TRACK_SUGGESTED, volunteerId)
}
