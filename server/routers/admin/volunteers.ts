import { z } from 'zod'
import { ORPCError } from '@orpc/server'
import { prisma } from '@/lib/prisma'
import { logger } from '@/lib/logger'
import { dismissDuplicatePair, findDuplicatePairs } from '@/lib/duplicate-accounts'
import { adminProcedure, staffProcedure } from '../../procedures'
import { canAdminChapter, type ChapterAccess } from '@/lib/chapter-access'
import { accountOverlap, mailboxKey, mayMerge, sameConfirmedMailbox } from '@/lib/account-overlap'
import { holdingRoles } from '@/lib/account-merge'
import {
  approveStaffMerge,
  finishStaffMerge,
  requestStaffMerge,
  withdrawStaffMerge,
} from '@/lib/staff-merge'
import {
  ChapterAuditAction,
  InterestStatus,
  ProjectStatus,
  StaffMergeGate,
  WorkItemType,
} from '@/generated/prisma/enums'
import { audit } from '@/lib/chapter-roles'
import { chapterCarers, globalAdminWhere, outranks, staffRoleOf } from '@/lib/chapter-access-server'
import { notifyUser } from '@/lib/notify'
import { isSuperAdmin, redactVolunteer, revokeAccess } from '@/lib/auth'
import { sendSuspensionEmail } from '@/lib/email'
import { checkRateLimit } from '@/lib/rate-limit'

const MAX_DETAIL_ROWS = 100

const EndorsementInputSchema = z.object({
  skillId: z.number().int({ message: 'skillId is required' }),
  // Mirrors the SkillEndorsementRating / SkillEndorsementSource enums; anything else fails at the database.
  rating: z.enum(['verified', 'strong', 'developing']).optional().default('verified'),
  source: z
    .enum(['project_outcome', 'quick_task', 'direct_observation'])
    .optional()
    .default('direct_observation'),
  sourceId: z.number().int().optional().nullable(),
  notes: z.string().optional().nullable(),
})

const MERGE_SELECT = {
  id: true,
  name: true,
  email: true,
  emailConfirmed: true,
  nationalChapterId: true,
  discordHandle: true,
  signalNumber: true,
  whatsappNumber: true,
  duplicateOfId: true,
} as const

/** Throws unless the volunteer is in a chapter the caller runs. */
async function assertRunsVolunteer(access: ChapterAccess, volunteerId: number) {
  const target = await prisma.volunteer.findFirst({
    where: { id: volunteerId, deletedAt: null },
    select: { nationalChapterId: true },
  })
  if (!target || !canAdminChapter(access, target.nationalChapterId)) {
    throw new ORPCError('NOT_FOUND', { message: 'Volunteer not found' })
  }
}

async function liveVolunteer(id: number) {
  const volunteer = await prisma.volunteer.findFirst({
    where: { id, deletedAt: null },
    select: { id: true, name: true, email: true, duplicateOfId: true },
  })
  if (!volunteer) throw new ORPCError('NOT_FOUND', { message: 'Volunteer not found' })
  return volunteer
}

const sameAs = (v: { name: string; email: string | null }) =>
  v.email ? `${v.name} (${v.email})` : v.name

/** A volunteer as their chapter's staff, or a global admin, see them. */
export const adminVolunteersRouter = {
  getById: staffProcedure
    .input(z.object({ id: z.number().int() }))
    .handler(async ({ input, context }) => {
      const vol = await prisma.volunteer.findUnique({
        where: { id: input.id },
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
          duplicateOf: { select: { id: true, name: true, email: true } },
          duplicates: {
            where: { deletedAt: null },
            select: { id: true, name: true, email: true },
            orderBy: { name: 'asc' },
          },
        },
      })

      if (!vol || !canAdminChapter(context.access, vol.nationalChapterId)) {
        throw new ORPCError('NOT_FOUND', { message: 'Volunteer not found' })
      }

      const [adminNotes, endorsements, quickTasks, projectHistory] = await Promise.all([
        prisma.adminNote.findMany({
          where: { volunteerId: input.id },
          include: { author: { select: { name: true } } },
          orderBy: { createdAt: 'desc' },
          take: MAX_DETAIL_ROWS,
        }),
        prisma.skillEndorsement.findMany({
          where: { volunteerId: input.id },
          include: {
            skill: { include: { category: true } },
            endorsedBy: { select: { name: true } },
          },
          orderBy: { createdAt: 'desc' },
          take: MAX_DETAIL_ROWS,
        }),
        prisma.workItem.findMany({
          where: {
            OR: [
              { type: WorkItemType.QUICK_TASK },
              { type: WorkItemType.TASK, parent: { standingRequests: true } },
            ],
            assigneeId: input.id,
          },
          include: { skill: { select: { name: true } } },
          orderBy: { createdAt: 'desc' },
          take: MAX_DETAIL_ROWS,
        }),
        prisma.workItem.findMany({
          where: {
            type: WorkItemType.PROJECT,
            OR: [{ assigneeId: input.id }, { creatorId: input.id }],
          },
          orderBy: { createdAt: 'desc' },
          take: MAX_DETAIL_ROWS,
        }),
      ])

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
      const publicEndorsements = vol.skillEndorsementsReceived.map((se) => ({
        skillId: se.skillId,
        rating: se.rating,
        skillName: se.skill.name,
      }))

      return {
        ...redactVolunteer(vol, {
          showContact: true,
          skills,
          endorsements: publicEndorsements,
        }),
        duplicateOf: vol.duplicateOf,
        duplicates: vol.duplicates,
        adminNotes: adminNotes.map((n) => ({
          id: n.id,
          volunteerId: n.volunteerId,
          authorId: n.authorId,
          content: n.content,
          category: n.category,
          relatedProjectId: n.relatedWorkItemId,
          createdAt: n.createdAt,
          updatedAt: n.updatedAt,
          authorName: n.author.name,
        })),
        endorsements: endorsements.map((e) => ({
          id: e.id,
          volunteerId: e.volunteerId,
          skillId: e.skillId,
          endorsedById: e.endorsedById,
          source: e.source,
          sourceId: e.sourceId,
          rating: e.rating,
          notes: e.notes,
          createdAt: e.createdAt,
          skillName: e.skill.name,
          skillCategory: e.skill.category.name,
          endorsedByName: e.endorsedBy.name,
        })),
        quickTasks: quickTasks.map((t) => ({
          id: t.id,
          projectId: t.contextProjectId,
          title: t.title,
          description: t.description,
          skillId: t.skillId,
          assignedToId: t.assigneeId,
          assignedById: t.creatorId,
          status: t.status,
          reviewRating: t.reviewRating,
          reviewNotes: t.reviewNotes,
          reviewedById: t.reviewedById,
          reviewedAt: t.reviewedAt,
          estimatedHours: t.estimatedHours,
          createdAt: t.createdAt,
          updatedAt: t.updatedAt,
          skillName: t.skill?.name ?? null,
        })),
        projectHistory: projectHistory.map((p) => ({
          id: p.id,
          title: p.title,
          description: p.description,
          status: p.status,
          ownerId: p.assigneeId,
          proposedById: p.creatorId,
          outcome: p.outcome,
          outcomeNotes: p.outcomeNotes,
          completedAt: p.completedAt,
          createdAt: p.createdAt,
          updatedAt: p.updatedAt,
        })),
      }
    }),

  listEndorsements: staffProcedure
    .input(z.object({ volunteerId: z.number().int() }))
    .handler(async ({ input, context }) => {
      await assertRunsVolunteer(context.access, input.volunteerId)
      const endorsements = await prisma.skillEndorsement.findMany({
        where: { volunteerId: input.volunteerId },
        include: {
          skill: { include: { category: true } },
          endorsedBy: { select: { name: true } },
        },
        orderBy: { createdAt: 'desc' },
        take: MAX_DETAIL_ROWS,
      })
      return endorsements.map((e) => ({
        id: e.id,
        volunteerId: e.volunteerId,
        skillId: e.skillId,
        endorsedById: e.endorsedById,
        source: e.source,
        sourceId: e.sourceId,
        rating: e.rating,
        notes: e.notes,
        createdAt: e.createdAt,
        skillName: e.skill.name,
        skillCategory: e.skill.category.name,
        endorsedByName: e.endorsedBy.name,
      }))
    }),

  addEndorsement: staffProcedure
    .input(z.object({ volunteerId: z.number().int() }).merge(EndorsementInputSchema))
    .handler(async ({ input, context }) => {
      await assertRunsVolunteer(context.access, input.volunteerId)
      const { skillId, rating, source, sourceId, notes } = input
      await prisma.skillEndorsement.upsert({
        where: {
          volunteerId_skillId_endorsedById: {
            volunteerId: input.volunteerId,
            skillId,
            endorsedById: context.volunteer.id,
          },
        },
        update: { rating, source, sourceId: sourceId ?? null, notes: notes ?? null },
        create: {
          volunteerId: input.volunteerId,
          skillId,
          endorsedById: context.volunteer.id,
          rating,
          source,
          sourceId: sourceId ?? null,
          notes: notes ?? null,
        },
      })
      return { message: 'Skill endorsed' }
    }),

  /**
   * The accounts this one could be merged with, for the merge dialog: marked as its duplicates or
   * it as theirs, or suggested by findDuplicatePairs; ones the viewer may merge (`mayMerge`), that
   * share more than a name (`isTelling`), and not recorded as different people. Each says which
   * side must be kept, when one holds a role that a merge cannot take away.
   */
  mergeCandidates: staffProcedure
    .input(z.object({ volunteerId: z.number().int() }))
    .handler(async ({ input, context }) => {
      const { access } = context
      const self = await prisma.volunteer.findFirst({
        where: { id: input.volunteerId, deletedAt: null },
        select: MERGE_SELECT,
      })
      if (!self || !canAdminChapter(access, self.nationalChapterId)) {
        throw new ORPCError('NOT_FOUND', { message: 'Volunteer not found' })
      }
      if (!access.globalAdmin && isSuperAdmin(self)) return []
      const mailbox = mailboxKey(self.email)
      const [marked, pairs, distinct, sameMailbox] = await Promise.all([
        prisma.volunteer.findMany({
          where: {
            deletedAt: null,
            OR: [{ duplicates: { some: { id: self.id } } }, { duplicateOfId: self.id }],
          },
          select: { id: true },
        }),
        findDuplicatePairs(self.id),
        prisma.distinctAccountPair.findMany({
          where: { OR: [{ volunteerAId: self.id }, { volunteerBId: self.id }] },
          select: { volunteerAId: true, volunteerBId: true },
        }),
        // Only Gmail lets two addresses reach one mailbox (mailboxKey); elsewhere they are unique.
        mailbox?.endsWith('@gmail.com')
          ? prisma.$queryRaw<{ id: number }[]>`
              SELECT id FROM volunteers
              WHERE deleted_at IS NULL AND id <> ${self.id}
                AND split_part(lower(email), '@', 2) IN ('gmail.com', 'googlemail.com')
                AND regexp_replace(split_part(split_part(lower(email), '@', 1), '+', 1), '\\.', '', 'g')
                  = ${mailbox.split('@')[0]}`
          : [],
      ])
      const apart = new Set(distinct.flatMap((d) => [d.volunteerAId, d.volunteerBId]))
      const ids = new Set([
        ...marked.map((m) => m.id),
        ...pairs.flatMap((p) => [p.a.id, p.b.id]),
        ...sameMailbox.map((m) => m.id),
      ])
      for (const id of [self.id, context.volunteer.id, ...apart]) ids.delete(id)
      const others = await prisma.volunteer.findMany({
        where: { id: { in: [...ids] }, deletedAt: null },
        select: { ...MERGE_SELECT, chapter: { select: { name: true } } },
      })
      const roles = await holdingRoles([self.id, ...others.map((o) => o.id)])
      const candidates = []
      for (const other of others) {
        const overlap = accountOverlap(self, other)
        if (!mayMerge(access, self, other)) continue
        if (!access.globalAdmin && isSuperAdmin(other)) continue
        // Without both addresses confirmed only a global admin can see it through.
        if (!access.globalAdmin && !(self.emailConfirmed && other.emailConfirmed)) continue
        if (roles.has(self.id) && roles.has(other.id)) continue
        candidates.push({
          id: other.id,
          name: other.name,
          chapterName: other.chapter?.name ?? null,
          overlap,
          /** Which must be kept, as a role goes with its account; null leaves it to the viewer. */
          mustKeep: roles.has(self.id)
            ? ('this' as const)
            : roles.has(other.id)
              ? ('other' as const)
              : null,
          /** Which to keep by default: the one not marked as a duplicate. */
          keepOther: self.duplicateOfId === other.id,
          /** Proof is asked for first, unless both addresses reach one confirmed mailbox. */
          gated: !sameConfirmedMailbox(self, other),
        })
      }
      return candidates
    }),

  /**
   * Folds one account into another (lib/account-merge.ts) for a global admin, or for the lead of
   * the chapter both accounts are in, when the two share more than a name (`isTelling`) and are
   * not recorded as different people. It signs in with a confirmed address where only one is.
   * Both mailboxes are told, and it is written to the audit log.
   */
  merge: staffProcedure
    .input(z.object({ keptId: z.number().int(), mergedId: z.number().int() }))
    .handler(async ({ input, context }) => {
      const { access } = context
      const actor = context.volunteer
      const [kept, merged] = await Promise.all(
        [input.keptId, input.mergedId].map((id) =>
          prisma.volunteer.findFirst({ where: { id, deletedAt: null }, select: MERGE_SELECT }),
        ),
      )
      if (!kept || !merged || !mayMerge(access, kept, merged)) {
        throw new ORPCError('NOT_FOUND', { message: 'Account not found' })
      }
      if ([kept.id, merged.id].includes(actor.id)) {
        throw new ORPCError('BAD_REQUEST', {
          message: 'Merge your own accounts from your settings',
        })
      }
      if (!access.globalAdmin && [kept, merged].some(isSuperAdmin)) {
        throw new ORPCError('FORBIDDEN', { message: "Only a global admin merges a global admin's" })
      }
      const [volunteerAId, volunteerBId] = [kept.id, merged.id].sort((x, y) => x - y)
      const apart = await prisma.distinctAccountPair.count({
        where: { volunteerAId, volunteerBId },
      })
      if (apart) {
        throw new ORPCError('BAD_REQUEST', {
          message: 'These accounts are on record as two different people',
        })
      }
      if (!sameConfirmedMailbox(kept, merged)) {
        const gate = await requestStaffMerge(kept, merged, {
          id: actor.id,
          globalAdmin: access.globalAdmin,
        })
        return {
          message:
            gate === StaffMergeGate.MAILBOXES
              ? `Sent ${kept.name} a link at each address; they merge once both are followed`
              : 'Another global admin needs to approve this merge',
        }
      }
      await finishStaffMerge(kept, merged, actor.id, { mailbox: true })
      return { message: `${merged.name}'s account is merged into ${kept.name}'s` }
    }),

  /** A second global admin approves a merge waiting on one (lib/staff-merge.ts). */
  approveMerge: adminProcedure
    .input(z.object({ id: z.number().int() }))
    .handler(async ({ input, context }) => {
      const request = await approveStaffMerge(input.id, context.volunteer.id)
      return { message: `${request.merged.name}'s account is merged into ${request.kept.name}'s` }
    }),

  /** A global admin takes back a merge still waiting for proof. */
  withdrawMerge: adminProcedure
    .input(z.object({ id: z.number().int() }))
    .handler(async ({ input }) => {
      await withdrawStaffMerge(input.id)
      return { message: 'Merge request withdrawn' }
    }),

  /**
   * Ends every session the member has, on every device, for their chapter's staff or a global
   * admin, as when an account may be in someone else's hands. They can sign in again as usual.
   */
  signOutEverywhere: staffProcedure
    .input(z.object({ volunteerId: z.number().int() }))
    .handler(async ({ input, context }) => {
      const target = await prisma.volunteer.findFirst({
        where: { id: input.volunteerId, deletedAt: null },
        select: {
          id: true,
          name: true,
          email: true,
          emailConfirmed: true,
          nationalChapterId: true,
        },
      })
      if (!target || !canAdminChapter(context.access, target.nationalChapterId)) {
        throw new ORPCError('NOT_FOUND', { message: 'Volunteer not found' })
      }
      if (target.id === context.volunteer.id) {
        throw new ORPCError('BAD_REQUEST', {
          message: 'Sign yourself out of other devices from your settings',
        })
      }
      if (await outranks(context.access, target)) {
        throw new ORPCError('FORBIDDEN', {
          message: `Only a global admin can sign ${target.name} out`,
        })
      }
      const { allowed } = checkRateLimit(
        context.request,
        `sign-out-everywhere:${context.volunteer.id}:${target.id}`,
        { limit: 3, windowMs: 60 * 60 * 1000 },
      )
      if (!allowed) {
        throw new ORPCError('TOO_MANY_REQUESTS', {
          message: `You have signed ${target.name} out several times this hour; try again later`,
        })
      }
      const revoked = await prisma.$transaction(async (tx) => {
        const ended = await revokeAccess(target.id, { db: tx })
        if (ended.sessions || ended.apiTokens) {
          await audit(tx, ChapterAuditAction.SESSIONS_REVOKED, {
            actorId: context.volunteer.id,
            chapterId: target.nationalChapterId,
            targetVolunteerId: target.id,
            details: ended,
          })
        }
        return ended
      })
      if (!revoked.sessions && !revoked.apiTokens) {
        return { message: `${target.name} was not signed in anywhere` }
      }
      await notifyUser(
        target.id,
        'signed_out_by_staff',
        'You were signed out on every device',
        'Someone who helps run Action Hub signed you out everywhere, in case your account was in someone else’s hands. Sign in again as usual. If you did not expect this, please change your password.',
        '/settings',
        {
          subject: 'You were signed out of Action Hub on every device',
          message:
            'Someone who helps run Action Hub signed you out on every device, in case your account was in someone else’s hands. You can sign in again as usual. If you did not expect this, please change your password from your settings.',
          ctaLabel: 'Open your settings',
          ctaUrl: '/settings',
        },
      )
      const tokens = revoked.apiTokens
        ? ` and ${revoked.apiTokens === 1 ? 'their API token is' : `their ${revoked.apiTokens} API tokens are`} revoked`
        : ''
      return { message: `${target.name} is signed out everywhere${tokens}` }
    }),

  /**
   * Suspends a member, or lifts it, for their chapter's lead or deputies or a global admin. Only
   * someone who runs nothing: a lead, deputy or coordinator gives up the role first, so no work
   * for the role waits on someone who cannot sign in. A suspended account cannot
   * sign in and is left out of the directory, pickers, calls and email; nothing is deleted. The
   * member is emailed (never the reason), and the chapter's staff and global admins are told.
   */
  setSuspended: staffProcedure
    .input(
      z.object({
        volunteerId: z.number().int(),
        suspended: z.boolean(),
        reason: z.string().trim().max(1000).optional(),
      }),
    )
    .handler(async ({ input, context }) => {
      const { access } = context
      const actor = context.volunteer
      const target = await prisma.volunteer.findFirst({
        where: { id: input.volunteerId, deletedAt: null },
        select: {
          id: true,
          name: true,
          email: true,
          emailConfirmed: true,
          nationalChapterId: true,
          coordinatorRole: { select: { id: true } },
        },
      })
      if (!target || !canAdminChapter(access, target.nationalChapterId)) {
        throw new ORPCError('NOT_FOUND', { message: 'Volunteer not found' })
      }
      if (target.id === actor.id) {
        throw new ORPCError('BAD_REQUEST', { message: 'You cannot suspend yourself' })
      }
      if (isSuperAdmin(target)) {
        throw new ORPCError('FORBIDDEN', { message: 'A global admin cannot be suspended here' })
      }
      const role = target.coordinatorRole ? 'is a coordinator' : await staffRoleOf(target.id)
      if (role) {
        throw new ORPCError('FORBIDDEN', {
          message: `${target.name} ${role}. Take the role away before suspending them.`,
        })
      }
      if (input.suspended && (input.reason ?? '').length < 3) {
        throw new ORPCError('BAD_REQUEST', { message: 'Say why, for the record' })
      }
      // Counted once the request is a sensible one; the limit is this server's, per member.
      const { allowed } = checkRateLimit(context.request, `suspend:${target.id}`, {
        limit: 5,
        windowMs: 60 * 60 * 1000,
      })
      if (!allowed) {
        throw new ORPCError('TOO_MANY_REQUESTS', {
          message: `${target.name}'s suspension has changed several times this hour; try later`,
        })
      }
      await prisma.$transaction(async (tx) => {
        // Changed only from the state it is in, so of two staff acting at once one is refused.
        const { count } = await tx.volunteer.updateMany({
          where: {
            id: target.id,
            suspendedAt: input.suspended ? null : { not: null },
          },
          data: input.suspended
            ? { suspendedAt: new Date(), suspendedById: actor.id, suspensionReason: input.reason }
            : { suspendedAt: null, suspendedById: null, suspensionReason: null },
        })
        if (!count) {
          throw new ORPCError('BAD_REQUEST', {
            message: input.suspended
              ? `${target.name} is already suspended`
              : `${target.name} is not suspended`,
          })
        }
        if (input.suspended) await revokeAccess(target.id, { db: tx })
        await audit(
          tx,
          input.suspended
            ? ChapterAuditAction.MEMBER_SUSPENDED
            : ChapterAuditAction.MEMBER_UNSUSPENDED,
          {
            actorId: actor.id,
            chapterId: target.nationalChapterId,
            targetVolunteerId: target.id,
            ...(input.suspended && { details: { reason: input.reason } }),
          },
        )
      })

      // Only to an address they proved is theirs; a failed send is logged, the change stands.
      if (target.email && target.emailConfirmed) {
        await sendSuspensionEmail({
          to: target.email,
          name: target.name,
          lifted: !input.suspended,
        }).catch((e) => logger.error(e, '[SUSPENSION] Email to the member failed'))
      }
      const title = input.suspended
        ? `${actor.name} suspended ${target.name}`
        : `${actor.name} lifted ${target.name}'s suspension`
      const told = new Set([
        ...(await chapterCarers(target.nationalChapterId)),
        ...(
          await prisma.volunteer.findMany({ where: globalAdminWhere(), select: { id: true } })
        ).map((a) => a.id),
      ])
      told.delete(actor.id)
      await Promise.all(
        [...told].map((id) =>
          notifyUser(
            id,
            'member_suspended',
            title,
            input.reason ?? null,
            `/volunteers/${target.id}`,
          ),
        ),
      )
      return {
        message: input.suspended
          ? `${target.name} is suspended`
          : `${target.name} is no longer suspended`,
      }
    }),

  /**
   * What has been done to the member, newest first, from the chapter audit log: their roles,
   * moves, and anything staff did to their account. For their chapter's staff or a global admin.
   */
  history: staffProcedure
    .input(z.object({ volunteerId: z.number().int() }))
    .handler(async ({ input, context }) => {
      const { access } = context
      await assertRunsVolunteer(access, input.volunteerId)
      const events = await prisma.chapterAuditEvent.findMany({
        where: {
          targetVolunteerId: input.volunteerId,
          // Chapter staff see what happened in their own chapter, as its log shows them,
          // including the move that brought the member in; a global admin sees all.
          ...(access.globalAdmin ? {} : { nationalChapterId: access.chapterId }),
        },
        include: {
          actor: { select: { id: true, name: true, deletedAt: true } },
          chapter: { select: { name: true } },
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: MAX_DETAIL_ROWS + 1,
      })
      return {
        events: events.slice(0, MAX_DETAIL_ROWS).map((e) => ({
          id: e.id,
          action: e.action,
          at: e.createdAt,
          // A deleted actor keeps their name on record but has no profile to link to.
          actor: e.actor && { id: e.actor.deletedAt ? null : e.actor.id, name: e.actor.name },
          chapterName: e.chapter?.name ?? null,
        })),
        more: events.length > MAX_DETAIL_ROWS,
      }
    }),

  /**
   * The live projects of the member's chapter (the pool's, for someone in it) that the caller,
   * as its staff, may invite them to or add them to: not ones they own, are already on, or have
   * asked to own. Each
   * says whether they asked to join (an invite then accepts them) or were invited already.
   */
  projectsToOffer: staffProcedure
    .input(z.object({ volunteerId: z.number().int() }))
    .handler(async ({ input, context }) => {
      await assertRunsVolunteer(context.access, input.volunteerId)
      const member = await prisma.volunteer.findUniqueOrThrow({
        where: { id: input.volunteerId },
        select: { nationalChapterId: true },
      })
      const projects = await prisma.workItem.findMany({
        where: {
          type: WorkItemType.PROJECT,
          nationalChapterId: member.nationalChapterId,
          status: { in: [ProjectStatus.ready, ProjectStatus.in_progress, ProjectStatus.on_hold] },
          OR: [{ assigneeId: null }, { assigneeId: { not: input.volunteerId } }],
        },
        select: {
          id: true,
          title: true,
          interests: {
            where: { volunteerId: input.volunteerId },
            select: { status: true, interestType: true },
          },
        },
        orderBy: { title: 'asc' },
      })
      return projects.flatMap((p) => {
        const [interest] = p.interests
        const status = interest?.status
        // An application to own the project is answered on the project, not by an invite.
        if (status === InterestStatus.accepted) return []
        if (status === InterestStatus.pending && interest.interestType === 'want_to_own') return []
        const standing =
          status === InterestStatus.pending
            ? ('applied' as const)
            : status === InterestStatus.invited
              ? ('invited' as const)
              : null
        return [{ id: p.id, title: p.title, standing }]
      })
    }),

  /** Pairs of accounts that look like one person; with `volunteerId`, that account's only. */
  possibleDuplicates: adminProcedure
    .input(z.object({ volunteerId: z.number().int().optional() }))
    .handler(({ input }) => findDuplicatePairs(input.volunteerId)),

  /** Says two accounts belong to different people, so they are not paired again. */
  dismissDuplicate: adminProcedure
    .input(z.object({ ids: z.tuple([z.number().int(), z.number().int()]) }))
    .handler(async ({ input, context }) => {
      await Promise.all(input.ids.map(liveVolunteer))
      await dismissDuplicatePair(input.ids, context.volunteer.id)
      return { message: 'Marked as different people' }
    }),

  /**
   * Marks `id` as a second account of whoever holds `duplicateOfId`, or clears the mark with
   * null. Accounts already marked as duplicates of `id` move to the new keeper, so a mark always
   * points at an account in use. Each change leaves an admin note on the accounts involved.
   */
  markDuplicate: adminProcedure
    .input(z.object({ id: z.number().int(), duplicateOfId: z.number().int().nullable() }))
    .handler(async ({ input, context }) => {
      const account = await liveVolunteer(input.id)
      const authorId = context.volunteer.id

      if (input.duplicateOfId === null) {
        if (account.duplicateOfId === null) {
          throw new ORPCError('BAD_REQUEST', {
            message: `${account.name} is not marked as a duplicate`,
          })
        }
        await prisma.$transaction([
          prisma.volunteer.update({ where: { id: account.id }, data: { duplicateOfId: null } }),
          prisma.adminNote.create({
            data: {
              volunteerId: account.id,
              authorId,
              content: 'No longer marked as a duplicate.',
            },
          }),
        ])
        return { message: `${account.name} is no longer marked as a duplicate` }
      }

      if (input.duplicateOfId === account.id) {
        throw new ORPCError('BAD_REQUEST', {
          message: 'An account cannot be a duplicate of itself',
        })
      }
      const keeper = await liveVolunteer(input.duplicateOfId)
      if (keeper.duplicateOfId !== null) {
        throw new ORPCError('BAD_REQUEST', {
          message: `${keeper.name} is itself marked as a duplicate`,
        })
      }
      const role = await staffRoleOf(account.id)
      if (role) {
        throw new ORPCError('BAD_REQUEST', {
          message: `${account.name} ${role}. Give the role to the account you are keeping first.`,
        })
      }

      await prisma.$transaction([
        prisma.volunteer.updateMany({
          where: { duplicateOfId: account.id },
          data: { duplicateOfId: keeper.id },
        }),
        prisma.volunteer.update({
          where: { id: account.id },
          data: { duplicateOfId: keeper.id },
        }),
        prisma.adminNote.createMany({
          data: [
            {
              volunteerId: account.id,
              authorId,
              content: `Marked as a duplicate of ${sameAs(keeper)}.`,
            },
            {
              volunteerId: keeper.id,
              authorId,
              content: `${sameAs(account)} marked as a duplicate of this account.`,
            },
          ],
        }),
      ])
      return { message: `${account.name} is marked as a duplicate of ${keeper.name}` }
    }),
}
