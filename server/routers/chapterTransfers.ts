import { z } from 'zod'
import { ORPCError } from '@orpc/server'
import { prisma } from '@/lib/prisma'
import { canAdminChapter, isStaff } from '@/lib/chapter-access'
import { askingChapter, decidingChapter } from '@/lib/chapter-transfers'
import { chapterFilter, mayUnseat } from '@/lib/chapter-access-server'
import { viewableVolunteers } from '@/lib/people'
import { assertKnownCountry } from '@/lib/chapter-placement'
import { audit, moveToChapter } from '@/lib/chapter-roles'
import { countryName } from '@/lib/countries-server'
import { clearNotifications, notifyChapterStaff, notifyUser } from '@/lib/notify'
import {
  ApprovalStatus,
  ChapterAuditAction,
  ChapterTransferKind,
  ChapterTransferStatus,
} from '@/generated/prisma/enums'
import { authedProcedure, staffProcedure } from '../procedures'

/**
 * Moving a member between chapters. A member moving country asks to move; their chapter's staff
 * may send them on to another chapter, or straight to the holding pool; and another chapter's
 * staff may ask to bring them in. Whoever is on the other side decides (`decidingChapter`): its
 * staff, or the global admins for the pool or a chapter with none. On approval the member leaves
 * their old chapter's staff role and local group but keeps the projects and teams they are on,
 * and is told. Global admins move anyone directly (`admin.chapters.reassign`).
 */
export const chapterTransfersRouter = {
  /** The caller's own request still waiting, if any. */
  mine: authedProcedure.handler(({ context }) =>
    prisma.chapterTransferRequest.findFirst({
      where: {
        volunteerId: context.volunteer.id,
        status: ChapterTransferStatus.pending,
        kind: ChapterTransferKind.SELF,
      },
      select: { id: true, toCountry: true, reason: true, createdAt: true },
    }),
  ),

  request: authedProcedure
    .input(
      z.object({
        country: z.string(),
        reason: z.string().trim().max(1000).optional().nullable(),
      }),
    )
    .handler(async ({ input, context }) => {
      const volunteer = context.volunteer
      await assertKnownCountry(input.country)
      if (input.country === volunteer.country) {
        throw new ORPCError('BAD_REQUEST', { message: 'That is already your country' })
      }
      const waiting = await prisma.chapterTransferRequest.findFirst({
        where: { volunteerId: volunteer.id, status: ChapterTransferStatus.pending },
      })
      if (waiting) {
        throw new ORPCError('BAD_REQUEST', {
          message:
            waiting.kind === ChapterTransferKind.SELF
              ? 'You already asked to move; cancel that first'
              : "Your chapter's organisers are already arranging a move for you",
        })
      }
      const to = await prisma.nationalChapter.findUnique({ where: { country: input.country } })
      const request = await prisma.chapterTransferRequest.create({
        data: {
          volunteerId: volunteer.id,
          fromChapterId: volunteer.nationalChapterId,
          toChapterId: to?.id ?? null,
          toCountry: input.country,
          reason: input.reason || null,
        },
      })
      await notifyChapterStaff(
        request.toChapterId,
        'chapter_transfer_request',
        `${volunteer.name} asks to move to ${await countryName(input.country)}`,
        input.reason || null,
        '/admin/transfers',
        undefined,
        request.id,
      )
      return { message: 'Request sent' }
    }),

  cancel: authedProcedure.handler(async ({ context }) => {
    const { count } = await prisma.chapterTransferRequest.updateMany({
      where: {
        volunteerId: context.volunteer.id,
        status: ChapterTransferStatus.pending,
        kind: ChapterTransferKind.SELF,
      },
      data: { status: ChapterTransferStatus.cancelled },
    })
    if (!count) throw new ORPCError('NOT_FOUND', { message: 'No request to cancel' })
    return { message: 'Request cancelled' }
  }),

  /**
   * Staff ask to move a member between chapters: their own member on to `toChapterId`, or (null)
   * straight to the holding pool, which needs nobody's answer; or another chapter's member into
   * their own. The other chapter's staff are asked.
   */
  requestFor: staffProcedure
    .input(
      z.object({
        volunteerId: z.number().int(),
        toChapterId: z.number().int().nullable(),
        reason: z.string().trim().max(1000).optional().nullable(),
      }),
    )
    .handler(async ({ input, context }) => {
      const { access } = context
      const actorId = context.volunteer.id
      const member = await prisma.volunteer.findFirst({
        where: { id: input.volunteerId, deletedAt: null },
        select: {
          id: true,
          name: true,
          nationalChapterId: true,
          approvalStatus: true,
          duplicateOfId: true,
        },
      })
      const from = member?.nationalChapterId ?? null
      const sending = Boolean(member) && canAdminChapter(access, from)
      // Bringing someone in needs no say over them, only that the caller can see them at all.
      const bringing =
        !sending &&
        Boolean(member) &&
        isStaff(access) &&
        access.chapterId === input.toChapterId &&
        (await viewableVolunteers(context.volunteer, access, [input.volunteerId])).has(
          input.volunteerId,
        )
      if (!member || (!sending && !bringing)) {
        throw new ORPCError('NOT_FOUND', { message: 'Volunteer not found' })
      }
      if (member.id === actorId) {
        throw new ORPCError('BAD_REQUEST', { message: 'Ask to move yourself from your settings' })
      }
      if (input.toChapterId === from) {
        throw new ORPCError('BAD_REQUEST', { message: `${member.name} is already there` })
      }
      if (sending && !(await mayUnseat(access, member))) {
        throw new ORPCError('FORBIDDEN', {
          message: `${member.name} helps run the chapter; whoever appoints them must move them`,
        })
      }

      if (input.toChapterId === null) {
        const waiting = await prisma.chapterTransferRequest.findFirst({
          where: { volunteerId: member.id, status: ChapterTransferStatus.pending },
          select: { id: true },
        })
        await prisma.$transaction((tx) => moveToChapter(tx, member.id, null, actorId))
        if (waiting) await clearNotifications('chapter_transfer_request', waiting.id)
        await notifyUser(
          member.id,
          'chapter_transfer_decided',
          "Moved: you're now in the holding pool",
          'Your chapter moved you out. You can ask to join a chapter from your settings.',
          '/settings',
        )
        return { message: `${member.name} is in the holding pool` }
      }

      if (member.approvalStatus !== ApprovalStatus.approved || member.duplicateOfId !== null) {
        throw new ORPCError('BAD_REQUEST', { message: 'Only an approved member can be moved' })
      }
      const to = await prisma.nationalChapter.findUnique({ where: { id: input.toChapterId } })
      if (!to) throw new ORPCError('NOT_FOUND', { message: 'Chapter not found' })
      const kind = sending ? ChapterTransferKind.SEND : ChapterTransferKind.BRING
      // One move waits at a time; checked in the same serializable transaction that adds it.
      const request = await prisma.$transaction(
        async (tx) => {
          const waiting = await tx.chapterTransferRequest.findFirst({
            where: { volunteerId: member.id, status: ChapterTransferStatus.pending },
          })
          if (waiting) {
            throw new ORPCError('BAD_REQUEST', {
              message: `${member.name} already has a move waiting for an answer`,
            })
          }
          const created = await tx.chapterTransferRequest.create({
            data: {
              volunteerId: member.id,
              fromChapterId: from,
              toChapterId: to.id,
              toCountry: to.country,
              reason: input.reason || null,
              kind,
              requestedById: actorId,
            },
          })
          await audit(tx, ChapterAuditAction.TRANSFER_REQUESTED, {
            actorId,
            chapterId: askingChapter(created),
            targetVolunteerId: member.id,
            details: { kind, fromChapterId: from, toChapterId: to.id },
          })
          return created
        },
        { isolationLevel: 'Serializable' },
      )
      await notifyChapterStaff(
        decidingChapter(request),
        'chapter_transfer_request',
        kind === ChapterTransferKind.SEND
          ? `${context.volunteer.name} asks you to take ${member.name} into ${to.name}`
          : `${context.volunteer.name} asks to bring ${member.name} into ${to.name}`,
        input.reason || null,
        '/admin/transfers',
        undefined,
        request.id,
      )
      return { message: `Asked: ${to.name}'s move for ${member.name} is waiting for an answer` }
    }),

  /** Staff of the side that asked take back a move nobody has answered yet. */
  withdraw: staffProcedure
    .input(z.object({ id: z.number().int() }))
    .handler(async ({ input, context }) => {
      const request = await prisma.chapterTransferRequest.findUnique({ where: { id: input.id } })
      if (
        !request ||
        request.kind === ChapterTransferKind.SELF ||
        !canAdminChapter(context.access, askingChapter(request))
      ) {
        throw new ORPCError('NOT_FOUND', { message: 'Request not found' })
      }
      const { count } = await prisma.chapterTransferRequest.updateMany({
        where: { id: request.id, status: ChapterTransferStatus.pending },
        data: { status: ChapterTransferStatus.cancelled },
      })
      if (!count) {
        throw new ORPCError('BAD_REQUEST', { message: 'This request has already been answered' })
      }
      await clearNotifications('chapter_transfer_request', request.id)
      return { message: 'Request withdrawn' }
    }),

  /** Requests to move into the caller's chapter; a global admin sees every chapter's. */
  list: staffProcedure
    .input(
      z
        .object({
          status: z.nativeEnum(ChapterTransferStatus).optional(),
          chapter: z.union([z.number().int(), z.literal('pool')]).optional(),
        })
        .optional(),
    )
    .handler(async ({ input, context }) => {
      const chapter = chapterFilter(context.access, input?.chapter)
      // Requests the chapter answers: to join it, or (BRING) to leave it.
      const answers =
        chapter === undefined
          ? {}
          : {
              OR: [
                { kind: { not: ChapterTransferKind.BRING }, toChapterId: chapter },
                { kind: ChapterTransferKind.BRING, fromChapterId: chapter },
              ],
            }
      const requests = await prisma.chapterTransferRequest.findMany({
        where: { status: input?.status ?? ChapterTransferStatus.pending, ...answers },
        include: {
          volunteer: { select: { id: true, name: true, country: true } },
          fromChapter: { select: { name: true } },
          toChapter: { select: { name: true } },
          requestedBy: { select: { id: true, name: true } },
        },
        orderBy: { createdAt: 'asc' },
      })
      return requests.map((r) => ({
        id: r.id,
        status: r.status,
        reason: r.reason,
        toCountry: r.toCountry,
        createdAt: r.createdAt,
        volunteer: r.volunteer,
        fromChapterName: r.fromChapter?.name ?? null,
        toChapterName: r.toChapter?.name ?? null,
        kind: r.kind,
        requestedBy: r.requestedBy,
      }))
    }),

  decide: staffProcedure
    .input(
      z.object({
        id: z.number().int(),
        approve: z.boolean(),
        note: z.string().trim().max(1000).optional().nullable(),
      }),
    )
    .handler(async ({ input, context }) => {
      const request = await prisma.chapterTransferRequest.findUnique({ where: { id: input.id } })
      if (!request || !canAdminChapter(context.access, decidingChapter(request))) {
        throw new ORPCError('NOT_FOUND', { message: 'Request not found' })
      }
      if (request.status !== ChapterTransferStatus.pending) {
        throw new ORPCError('BAD_REQUEST', { message: 'This request has already been answered' })
      }
      const member = await prisma.volunteer.findUniqueOrThrow({
        where: { id: request.volunteerId },
        select: { id: true, name: true, nationalChapterId: true },
      })
      // Unless they asked themselves, letting a lead or deputy go is for whoever appoints them.
      if (
        input.approve &&
        request.kind !== ChapterTransferKind.SELF &&
        !(await mayUnseat(context.access, member))
      ) {
        throw new ORPCError('FORBIDDEN', {
          message: `${member.name} helps run the chapter; whoever appoints them must agree`,
        })
      }
      const actorId = context.volunteer.id
      const decided = {
        status: input.approve ? ChapterTransferStatus.approved : ChapterTransferStatus.declined,
        decidedById: actorId,
        decidedAt: new Date(),
        decisionNote: input.note || null,
      }
      await prisma.$transaction(async (tx) => {
        await tx.chapterTransferRequest.update({ where: { id: request.id }, data: decided })
        if (input.approve) {
          await moveToChapter(
            tx,
            request.volunteerId,
            request.toChapterId,
            actorId,
            ChapterAuditAction.TRANSFER_APPROVED,
          )
          // The holding pool has no country of its own, so the one they named is kept.
          await tx.volunteer.update({
            where: { id: request.volunteerId },
            data: { country: request.toCountry, locationConfirmedAt: new Date() },
          })
        } else {
          await audit(tx, ChapterAuditAction.TRANSFER_DECLINED, {
            actorId,
            chapterId: decidingChapter(request),
            targetVolunteerId: request.volunteerId,
          })
        }
      })
      await clearNotifications('chapter_transfer_request', request.id)
      const where = await countryName(request.toCountry)
      // The member hears when they move, and of a refusal only when they asked themselves.
      if (input.approve || request.kind === ChapterTransferKind.SELF) {
        await notifyUser(
          request.volunteerId,
          'chapter_transfer_decided',
          input.approve ? `Moved: you're now in ${where}` : `Declined: your move to ${where}`,
          input.note || null,
          '/settings',
        )
      }
      if (request.requestedById) {
        await notifyUser(
          request.requestedById,
          'chapter_transfer_decided',
          input.approve
            ? `Moved: ${member.name} is now in ${where}`
            : `Declined: moving ${member.name} to ${where}`,
          input.note || null,
          `/volunteers/${request.volunteerId}`,
        )
      }
      return { message: input.approve ? 'Moved' : 'Declined' }
    }),
}
