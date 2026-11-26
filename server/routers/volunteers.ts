import { z } from 'zod'
import { ORPCError } from '@orpc/server'
import { saveDeliveries, unchoosableTypes } from '@/lib/notification-preferences'
import { Prisma, type Volunteer } from '@/generated/prisma/client'
import { prisma } from '@/lib/prisma'
import { groupIn, placement } from '@/lib/chapter-placement'
import { isSuperAdmin, redactVolunteer } from '@/lib/auth'
import { TimeZoneSchema, UpdateVolunteerSchema } from '@/lib/schemas'
import { projectScopeWhere } from '@/lib/work-item'
import { historySelect, historyWhere, projectHistory } from '@/lib/volunteer-history'
import { contactRelations, seesFullProfile } from '@/lib/contact'
import {
  canAdminChapter,
  canAppointDeputies,
  isStaff,
  seesEveryChapter,
  staffRoleIn,
  type ChapterAccess,
} from '@/lib/chapter-access'
import { peopleInfo, viewableVolunteers } from '@/lib/people'
import { chapterFilter, mayUnseat, outranks, staffRoleOf } from '@/lib/chapter-access-server'
import { pendingMergeView } from '@/lib/staff-merge'
import { isActiveRecently } from '@/lib/activity'
import { askingChapter, decidingChapter } from '@/lib/chapter-transfers'
import { NOT_NOW_MESSAGE, dismissFastTrack, setFastTrack } from '@/lib/fast-track'
import { approvedProcedure, authedProcedure } from '../procedures'
import {
  ApprovalStatus,
  ChapterTransferKind,
  ChapterTransferStatus,
  ContactRequestStatus,
  ProjectStatus,
  TaskStatus,
  WorkItemType,
} from '@/generated/prisma/enums'

/** Whether someone is signed in anywhere, and holds API tokens, for the sign-out control. */
async function signedInState(volunteerId: number) {
  const now = new Date()
  const [sessions, apiTokens] = await Promise.all([
    prisma.session.count({ where: { volunteerId, expiresAt: { gt: now } } }),
    prisma.apiToken.count({
      where: { volunteerId, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
    }),
  ])
  return { signedIn: sessions > 0, apiTokens }
}

/**
 * What the viewer may do to this member from their profile, each key present only when they may;
 * null when nothing. The endpoints each control calls check again. A chapter's staff (or a global
 * admin) see it for the members they run, never for themselves.
 */
async function manageControls(
  viewerId: number,
  access: ChapterAccess,
  vol: Pick<
    Volunteer,
    | 'id'
    | 'email'
    | 'emailConfirmed'
    | 'isAdmin'
    | 'nationalChapterId'
    | 'duplicateOfId'
    | 'approvalStatus'
    | 'suspendedAt'
    | 'suspendedById'
    | 'suspensionReason'
    | 'fastTrack'
  >,
) {
  const chapterId = vol.nationalChapterId
  if (vol.id === viewerId || !canAdminChapter(access, chapterId)) return null
  const [chapter, coordinator] = await Promise.all([
    chapterId === null
      ? null
      : prisma.nationalChapter.findUniqueOrThrow({
          where: { id: chapterId },
          select: {
            lead: { select: { id: true, name: true } },
            deputies: { where: { volunteerId: vol.id }, select: { id: true } },
          },
        }),
    prisma.coordinator.findUnique({ where: { volunteerId: vol.id }, select: { remit: true } }),
  ])
  // Those who outrank the viewer are left alone: no sign-out, no picture taken down.
  const outranked = await outranks(access, vol, chapter?.lead?.id ?? null)
  const signIn = outranked ? null : await signedInState(vol.id)
  const isLead = chapter?.lead?.id === vol.id
  const isDeputy = Boolean(chapter?.deputies.length)
  const duplicate = vol.duplicateOfId !== null
  const canCoordinate =
    !duplicate && vol.approvalStatus === ApprovalStatus.approved && Boolean(vol.emailConfirmed)

  // No role for someone suspended (lib/chapter-roles.ts); lift it first.
  const suspended = vol.suspendedAt !== null
  return {
    chapterDeputy:
      !suspended &&
      chapterId !== null &&
      canAppointDeputies(access, chapterId) &&
      !isLead &&
      (isDeputy || !duplicate)
        ? { chapterId, isDeputy }
        : null,
    chapterLead:
      !suspended && chapterId !== null && access.globalAdmin && (isLead || !duplicate)
        ? { chapterId, isLead, currentLead: isLead ? null : (chapter?.lead ?? null) }
        : null,
    coordinator:
      !suspended && access.globalAdmin && (coordinator || canCoordinate)
        ? { isCoordinator: Boolean(coordinator), remit: coordinator?.remit ?? null }
        : null,
    moveChapter: access.globalAdmin ? { chapterId } : null,
    /** Whether the viewer merges accounts here (the dialog reads candidates when opened), and any merge waiting on proof. */
    merge:
      access.globalAdmin ||
      (staffRoleIn(access, vol.nationalChapterId) === 'LEAD' && !isSuperAdmin(vol))
        ? {
            pending: await pendingMergeView(vol.id, {
              id: viewerId,
              globalAdmin: access.globalAdmin,
            }),
          }
        : null,
    removePicture: !outranked,
    signOutEverywhere: signIn,
    // Only someone who runs nothing, anywhere, as admin.volunteers.setSuspended requires.
    suspend:
      !isSuperAdmin(vol) && !coordinator && (await staffRoleOf(vol.id)) === null
        ? { suspension: vol.suspendedAt ? await suspensionOf(vol) : null }
        : null,
    /**
     * The Work group: verify skills, fast track, invite or add to a project. Only for an
     * approved account that is not a duplicate, so the work lands on the record in use.
     */
    work: !duplicate && vol.approvalStatus === ApprovalStatus.approved,
    /** Whether they are on fast track, for the control that puts them on or takes them off. */
    fastTrack: { on: vol.fastTrack },
  }
}

/** When and by whom a member was suspended, and why, for the staff who may lift it. */
async function suspensionOf(vol: {
  suspendedAt: Date | null
  suspendedById: number | null
  suspensionReason: string | null
}) {
  const by = vol.suspendedById
    ? await prisma.volunteer.findUnique({
        where: { id: vol.suspendedById },
        select: { name: true },
      })
    : null
  return { at: vol.suspendedAt as Date, byName: by?.name ?? null, reason: vol.suspensionReason }
}

/**
 * Chapter moves the viewer may ask for from this profile, and any move already waiting. Their
 * chapter's lead or deputies may send them on or to the holding pool; another chapter's staff
 * may ask to bring them in; a global admin moves them directly (`manage.moveChapter`). Null when
 * none of it applies.
 */
async function moveControls(
  viewerId: number,
  access: ChapterAccess,
  vol: { id: number; nationalChapterId: number | null; duplicateOfId: number | null } & {
    approvalStatus: ApprovalStatus | null
  },
) {
  if (vol.id === viewerId) return null
  const runs = canAdminChapter(access, vol.nationalChapterId)
  const ownChapter = access.chapterId
  const elsewhere =
    !runs && isStaff(access) && ownChapter !== null && ownChapter !== vol.nationalChapterId
  if (!runs && !elsewhere) return null
  const [pending, own] = await Promise.all([
    prisma.chapterTransferRequest.findFirst({
      where: { volunteerId: vol.id, status: ChapterTransferStatus.pending },
      include: {
        fromChapter: { select: { name: true } },
        toChapter: { select: { name: true } },
        requestedBy: { select: { name: true } },
      },
    }),
    elsewhere
      ? prisma.nationalChapter.findUniqueOrThrow({
          where: { id: ownChapter },
          select: { id: true, name: true },
        })
      : null,
  ])
  const movable = vol.approvalStatus === ApprovalStatus.approved && vol.duplicateOfId === null
  const send =
    runs && !access.globalAdmin && vol.nationalChapterId !== null && (await mayUnseat(access, vol))
  // Asking to bring them in waits until no other move does.
  const bringInto = own && movable && !pending ? own : null
  // Another chapter's staff see a move only when it concerns their own chapter.
  const seen =
    pending && (runs || [pending.fromChapterId, pending.toChapterId].includes(ownChapter))
      ? {
          id: pending.id,
          kind: pending.kind,
          fromChapterName: pending.fromChapter?.name ?? null,
          toChapterName: pending.toChapter?.name ?? null,
          requestedByName: pending.requestedBy?.name ?? null,
          canAnswer: canAdminChapter(access, decidingChapter(pending)),
          canWithdraw:
            pending.kind !== ChapterTransferKind.SELF &&
            canAdminChapter(access, askingChapter(pending)),
        }
      : null
  if (!send && !bringInto && !seen) return null
  return { send: send && movable, toPool: send, bringInto, pending: seen }
}

/** The volunteer, once the viewer is shown to be on their chapter's staff (or a global admin). */
async function findForFastTrack(access: ChapterAccess, volunteerId: number) {
  const target = await prisma.volunteer.findFirst({
    where: { id: volunteerId, deletedAt: null },
    select: { id: true, nationalChapterId: true },
  })
  if (!target || !canAdminChapter(access, target.nationalChapterId)) {
    throw new ORPCError('FORBIDDEN', {
      message: "Only their chapter's lead or deputies can change fast track",
    })
  }
  return target
}

export const volunteersRouter = {
  /** Their chapter's staff put a volunteer on fast track, or take them off (lib/fast-track.ts). */
  setFastTrack: approvedProcedure
    .input(z.object({ volunteerId: z.number().int(), on: z.boolean() }))
    .handler(async ({ input, context }) => {
      if (input.volunteerId === context.volunteer.id) {
        throw new ORPCError('BAD_REQUEST', { message: 'Someone else decides your fast track' })
      }
      await findForFastTrack(context.access, input.volunteerId)
      await setFastTrack(input.volunteerId, input.on, context.volunteer.id)
      return { message: input.on ? 'On fast track' : 'Off fast track' }
    }),

  /** "Not now" on an ask to put someone on fast track (lib/fast-track.ts). */
  dismissFastTrack: approvedProcedure
    .input(z.object({ volunteerId: z.number().int() }))
    .handler(async ({ input, context }) => {
      await findForFastTrack(context.access, input.volunteerId)
      await dismissFastTrack(input.volunteerId)
      return { message: NOT_NOW_MESSAGE }
    }),

  list: approvedProcedure
    .input(
      z.object({
        skillIds: z.array(z.number().int()).optional(),
        search: z.string().optional(),
        /** A global admin's or coordinator's choice of chapter; everyone else sees their own. */
        chapter: z.union([z.number().int(), z.literal('pool')]).optional(),
        localGroup: z.string().optional(),
        limit: z.number().int().min(1).max(100).optional().default(50),
        offset: z.number().int().min(0).optional().default(0),
      }),
    )
    .handler(async ({ input, context }) => {
      const currentVolunteer = context.volunteer
      // The directory is the viewer's chapter's, and its staff see profiles hidden from it. A
      // global admin or coordinator sees every chapter's, hidden profiles included.
      const seesAll = seesEveryChapter(context.access)
      const seesHidden = seesAll || canAdminChapter(context.access, context.access.chapterId)

      // A global admin sees, and searches by, each volunteer's login address, and sees which
      // accounts are marked as another's duplicate.
      const { globalAdmin } = context.access

      const textConditions: Prisma.Sql[] = []
      if (input.search) {
        const like = `%${input.search}%`
        const byEmail = globalAdmin ? Prisma.sql` OR email ILIKE ${like}` : Prisma.empty
        textConditions.push(
          Prisma.sql`(public.unaccent(name) ILIKE public.unaccent(${like}) OR public.unaccent(COALESCE(bio, '')) ILIKE public.unaccent(${like})${byEmail})`,
        )
      }
      if (input.localGroup) {
        const like = `%${input.localGroup}%`
        textConditions.push(
          Prisma.sql`(local_group_id IN (SELECT id FROM local_groups WHERE name = ${input.localGroup}) OR (local_group_id IS NULL AND public.unaccent(COALESCE(location, '')) ILIKE public.unaccent(${like})))`,
        )
      }
      const matchingIds = textConditions.length
        ? (
            await prisma.$queryRaw<{ id: number }[]>`
              SELECT id FROM volunteers WHERE ${Prisma.join(textConditions, ' AND ')}
            `
          ).map((row) => row.id)
        : null

      const where: Record<string, unknown> = {
        deletedAt: null,
        // Out of every list and picker; its staff find it on the chapter's page.
        suspendedAt: null,
        nationalChapterId: chapterFilter(context.access, input.chapter, seesAll),
        ...(seesHidden ? {} : { consentMakeProfileVisibleInDirectory: true }),
        approvalStatus: ApprovalStatus.approved,
        ...(input.skillIds && input.skillIds.length > 0
          ? { skills: { some: { skillId: { in: input.skillIds } } } }
          : {}),
        ...(matchingIds !== null ? { id: { in: matchingIds } } : {}),
      }

      const [volunteers, total] = await Promise.all([
        prisma.volunteer.findMany({
          where,
          select: {
            id: true,
            name: true,
            email: true,
            bio: true,
            availabilityHoursPerWeek: true,
            location: true,
            country: true,
            otherSkills: true,
            group: { select: { name: true } },
            duplicateOf: { select: { id: true, name: true } },
            createdAt: true,
            lastActiveAt: true,
            consentMakeProfileVisibleInDirectory: true,
            skills: {
              include: { skill: { include: { category: true } } },
              orderBy: [
                { skill: { category: { sortOrder: 'asc' } } },
                { skill: { sortOrder: 'asc' } },
              ],
            },
          },
          orderBy: { createdAt: 'desc' },
          take: input.limit,
          skip: input.offset,
        }),
        prisma.volunteer.count({ where }),
      ])

      const relations = await contactRelations(
        currentVolunteer,
        context.access,
        volunteers.map((v) => v.id),
      )
      return {
        volunteers: volunteers.map((v) => ({
          id: v.id,
          canMessage: v.id !== currentVolunteer.id && relations.reachable.has(v.id),
          contactRequested: relations.requested.has(v.id),
          activeRecently: isActiveRecently(v.lastActiveAt),
          name: v.name,
          ...(globalAdmin ? { email: v.email, duplicateOf: v.duplicateOf } : {}),
          bio: v.bio,
          availabilityHoursPerWeek: v.availabilityHoursPerWeek,
          location: v.location,
          country: v.country,
          otherSkills: v.otherSkills,
          localGroup: v.group?.name ?? null,
          createdAt: v.createdAt,
          hiddenFromDirectory: seesHidden ? !v.consentMakeProfileVisibleInDirectory : false,
          skills: v.skills.map((vs) => ({
            id: vs.skill.id,
            categoryId: vs.skill.categoryId,
            name: vs.skill.name,
            description: vs.skill.description,
            sortOrder: vs.skill.sortOrder,
            createdAt: vs.skill.createdAt,
            categoryName: vs.skill.category.name,
            proficiencyLevel: vs.proficiencyLevel,
          })),
        })),
        total,
      }
    }),

  /**
   * For names shown on a page: whether each links to a profile the viewer can open, and the
   * role it is badged with. Someone still awaiting approval can open only their own.
   */
  lookup: authedProcedure
    .input(z.object({ ids: z.array(z.number().int()).max(200) }))
    .handler(async ({ input, context }) => {
      const people = await peopleInfo(context.volunteer, context.access, input.ids)
      const approved =
        context.volunteer.approvalStatus === ApprovalStatus.approved || context.volunteer.isAdmin
      return approved
        ? people
        : people.map((p) => {
            const own = p.id === context.volunteer.id
            return { ...p, canView: own, picture: own ? p.picture : null }
          })
    }),

  getById: approvedProcedure
    .input(z.object({ id: z.number().int() }))
    .handler(async ({ input, context }) => {
      const currentVolunteer = context.volunteer

      const vol = await prisma.volunteer.findFirst({
        where: { id: input.id, deletedAt: null },
        include: {
          group: { select: { name: true } },
          chapter: { select: { name: true, country: true } },
          skills: {
            include: { skill: { include: { category: true } } },
            orderBy: [
              { skill: { category: { sortOrder: 'asc' } } },
              { skill: { sortOrder: 'asc' } },
            ],
          },
          skillEndorsementsReceived: {
            include: { skill: true, endorsedBy: { select: { name: true, deletedAt: true } } },
            orderBy: { createdAt: 'asc' },
          },
          duplicateOf: { select: { id: true, name: true } },
        },
      })

      if (
        !vol ||
        !(await viewableVolunteers(currentVolunteer, context.access, [vol.id])).has(vol.id)
      ) {
        throw new ORPCError('NOT_FOUND', { message: 'Volunteer not found' })
      }
      const isAdmin = canAdminChapter(context.access, vol.nationalChapterId)

      // Contact details go only to people who work with the volunteer, or whom they have
      // accepted a contact request from; their chapter's staff and coordinators see them too
      // (lib/contact.ts).
      const [relations, incoming, manage, move] = await Promise.all([
        contactRelations(currentVolunteer, context.access, [vol.id]),
        prisma.contactRequest.findFirst({
          where: {
            fromVolunteerId: vol.id,
            toVolunteerId: currentVolunteer.id,
            status: ContactRequestStatus.pending,
          },
          select: { id: true, message: true },
        }),
        manageControls(currentVolunteer.id, context.access, vol),
        moveControls(currentVolunteer.id, context.access, vol),
      ])
      const showContact = isAdmin || relations.reachable.has(vol.id)

      const skills = vol.skills.map((vs) => ({
        id: vs.skill.id,
        categoryId: vs.skill.categoryId,
        name: vs.skill.name,
        description: vs.skill.description,
        sortOrder: vs.skill.sortOrder,
        createdAt: vs.skill.createdAt,
        categoryName: vs.skill.category.name,
        proficiencyLevel: vs.proficiencyLevel,
      }))
      // How and when each skill was verified, for the tooltip on its chip; never the reviewer's
      // notes. Who verified it is for the person's chapter staff and those who see full profiles.
      const seesVerifier = isAdmin || seesFullProfile(context.access, vol)
      const endorsements = vol.skillEndorsementsReceived.map((se) => ({
        skillId: se.skillId,
        rating: se.rating,
        skillName: se.skill.name,
        source: se.source,
        endorsedByName: seesVerifier && !se.endorsedBy.deletedAt ? se.endorsedBy.name : null,
        createdAt: se.createdAt,
      }))

      const history = {
        volunteerId: input.id,
        seesEnded: vol.id === currentVolunteer.id || isAdmin,
      }
      const [projects, completedTasks] = await Promise.all([
        prisma.workItem.findMany({
          where: {
            ...historyWhere(history),
            AND: [
              projectScopeWhere(currentVolunteer),
              // A draft is its creator's and admins' alone, as on the project page.
              currentVolunteer.isAdmin
                ? {}
                : {
                    OR: [
                      { status: { not: ProjectStatus.draft } },
                      { creatorId: currentVolunteer.id },
                    ],
                  },
            ],
            status: {
              notIn: [
                ProjectStatus.archived,
                ProjectStatus.pending_review,
                ProjectStatus.needs_discussion,
              ],
            },
          },
          select: historySelect(history),
        }),
        prisma.workItem.findMany({
          where: {
            type: WorkItemType.TASK,
            parent: { standingRequests: true },
            assigneeId: input.id,
            status: TaskStatus.completed,
            // Rated ones are quick tasks from before; a poor rating is not shown off.
            OR: [{ reviewRating: null }, { reviewRating: { in: ['excellent', 'good'] } }],
          },
          orderBy: [{ completedAt: 'desc' }, { id: 'desc' }],
          select: {
            title: true,
            reviewRating: true,
            reviewedAt: true,
            skill: { select: { name: true } },
          },
        }),
      ])

      // Only a global admin sees the login address on a profile, and which account this one
      // duplicates: everyone else reaches the volunteer through the message relay.
      const { email, ...profile } = redactVolunteer(vol, {
        showContact,
        skills,
        endorsements,
      })
      return {
        ...profile,
        ...(context.access.globalAdmin ? { email, duplicateOf: vol.duplicateOf } : {}),
        canMessage: vol.id !== currentVolunteer.id && showContact,
        contactRequested: relations.requested.has(vol.id),
        incomingContactRequest: incoming,
        canRequestContact:
          !showContact &&
          vol.id !== currentVolunteer.id &&
          Boolean(vol.consentMakeProfileVisibleInDirectory),
        activeRecently: isActiveRecently(vol.lastActiveAt),
        chapter: vol.chapter,
        manage,
        move,
        // lib/fast-track.ts says who sees it; staff change it from `manage`.
        fastTrack: vol.id === currentVolunteer.id || isAdmin ? { on: vol.fastTrack } : null,
        projects: projectHistory(projects, input.id),
        completedTasks: completedTasks.map((t) => ({
          title: t.title,
          reviewRating: t.reviewRating,
          reviewedAt: t.reviewedAt,
          skillName: t.skill?.name ?? null,
        })),
      }
    }),

  myApplication: authedProcedure.handler(async ({ context }) => {
    const volunteer = context.volunteer
    return {
      approvalStatus: volunteer.approvalStatus,
      applicationMessage: volunteer.applicationMessage,
      applicationApplicantNotes: volunteer.applicationApplicantNotes,
    }
  }),

  resubmitApplication: authedProcedure.handler(async ({ context }) => {
    const volunteer = context.volunteer
    if (
      volunteer.approvalStatus !== ApprovalStatus.pending &&
      volunteer.approvalStatus !== ApprovalStatus.needs_info
    ) {
      throw new ORPCError('BAD_REQUEST', {
        message: `Cannot resubmit a ${volunteer.approvalStatus} application`,
      })
    }
    await prisma.volunteer.update({
      where: { id: volunteer.id },
      data: { approvalStatus: ApprovalStatus.under_review, updatedAt: new Date() },
    })
    return { message: 'Application resubmitted for review' }
  }),

  /** Records the browser's time zone for someone who has none yet; a chosen one is kept. */
  detectTimeZone: authedProcedure
    .input(z.object({ timeZone: TimeZoneSchema }))
    .handler(async ({ input, context }) => {
      const { count } = await prisma.volunteer.updateMany({
        where: { id: context.volunteer.id, timeZone: null },
        data: { timeZone: input.timeZone },
      })
      return { saved: count > 0 }
    }),

  updateMe: authedProcedure.input(UpdateVolunteerSchema).handler(async ({ input, context }) => {
    const volunteer = context.volunteer
    const data: Record<string, unknown> = { updatedAt: new Date() }

    const scalarFields = [
      'name',
      'bio',
      'discordHandle',
      'signalNumber',
      'whatsappNumber',
      'contactPreference',
      'contactNotes',
      'availabilityHoursPerWeek',
      'location',
      'otherSkills',
      'emailDigest',
      'dailySummary',
      'timeZone',
      'digestFrequency',
      'digestHour',
      'applicationMessage',
    ] as const
    for (const field of scalarFields) {
      if (Object.prototype.hasOwnProperty.call(input, field)) {
        data[field] = input[field]
      }
    }

    // Country decides chapter, so changing it is a transfer request. Only someone who never
    // gave one (an account from before signup asked) names it here, as signup would.
    const hasCountry = Object.prototype.hasOwnProperty.call(input, 'country')
    const hasLocalGroup = Object.prototype.hasOwnProperty.call(input, 'localGroup')
    if (hasCountry && input.country && input.country !== volunteer.country) {
      if (volunteer.country || volunteer.nationalChapterId !== null) {
        throw new ORPCError('BAD_REQUEST', {
          message: 'To move to another country, ask to transfer chapter from your settings',
        })
      }
      Object.assign(data, await placement(input.country, input.localGroup))
    } else if (hasLocalGroup) {
      Object.assign(data, await groupIn(volunteer.nationalChapterId, input.localGroup))
    }
    if (Object.prototype.hasOwnProperty.call(input, 'location') || hasCountry || hasLocalGroup) {
      data.locationConfirmedAt = new Date()
    }

    if (input.consentMakeProfileVisibleInDirectory !== undefined) {
      data.consentMakeProfileVisibleInDirectory = input.consentMakeProfileVisibleInDirectory
      if (input.consentMakeProfileVisibleInDirectory) data.consentGivenAt = new Date()
    }
    if (input.consentContactableByProjectOwners !== undefined) {
      data.consentContactableByProjectOwners = input.consentContactableByProjectOwners
      if (input.consentContactableByProjectOwners) data.consentGivenAt = new Date()
    }
    if (input.consentShareContactInfoWithProjectOwner !== undefined) {
      data.consentShareContactInfoWithProjectOwner = input.consentShareContactInfoWithProjectOwner
      if (input.consentShareContactInfoWithProjectOwner) data.consentGivenAt = new Date()
    }
    if (Object.prototype.hasOwnProperty.call(input, 'cookieConsentAnalytics')) {
      data.cookieConsentAnalytics = input.cookieConsentAnalytics ?? null
    }

    const skillIds = input.skillIds
    const preferences = input.notificationPreferences
    if (preferences) {
      const refused = unchoosableTypes(preferences)
      if (refused.length > 0) {
        throw new ORPCError('BAD_REQUEST', {
          message: `These notifications have no choice to make: ${refused.join(', ')}`,
        })
      }
    }

    const [vol] = await prisma.$transaction(async (tx) => {
      if (preferences) {
        await saveDeliveries(
          tx,
          volunteer.id,
          { isTechnicalAdmin: !!volunteer.isTechnicalAdmin },
          preferences,
        )
      }
      const updated = await tx.volunteer.update({
        where: { id: volunteer.id },
        data,
        include: {
          group: { select: { name: true } },
          skills: {
            include: { skill: { include: { category: true } } },
            orderBy: [
              { skill: { category: { sortOrder: 'asc' } } },
              { skill: { sortOrder: 'asc' } },
            ],
          },
          skillEndorsementsReceived: {
            include: { skill: true },
          },
        },
      })

      if (skillIds !== undefined) {
        await tx.volunteerSkill.deleteMany({ where: { volunteerId: volunteer.id } })
        if (skillIds.length > 0) {
          await tx.volunteerSkill.createMany({
            data: skillIds.map((skillId) => ({ volunteerId: volunteer.id, skillId })),
          })
        }
        const fresh = await tx.volunteer.findUnique({
          where: { id: volunteer.id },
          include: {
            group: { select: { name: true } },
            skills: {
              include: { skill: { include: { category: true } } },
              orderBy: [
                { skill: { category: { sortOrder: 'asc' } } },
                { skill: { sortOrder: 'asc' } },
              ],
            },
            skillEndorsementsReceived: {
              include: { skill: true },
            },
          },
        })
        return [fresh!]
      }

      return [updated]
    })

    const skills = vol.skills.map((vs) => ({
      id: vs.skill.id,
      categoryId: vs.skill.categoryId,
      name: vs.skill.name,
      description: vs.skill.description,
      sortOrder: vs.skill.sortOrder,
      createdAt: vs.skill.createdAt,
      categoryName: vs.skill.category.name,
      proficiencyLevel: vs.proficiencyLevel,
    }))
    const endorsements = vol.skillEndorsementsReceived.map((se) => ({
      skillId: se.skillId,
      rating: se.rating,
      skillName: se.skill.name,
    }))

    return redactVolunteer(vol, {
      showContact: true,
      skills,
      endorsements,
    })
  }),
}
