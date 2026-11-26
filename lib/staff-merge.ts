import { ORPCError } from '@orpc/server'
import { prisma } from './prisma'
import { mergeAccounts } from './account-merge'
import { mailboxKey, sameConfirmedMailbox } from './account-overlap'
import { audit } from './chapter-roles'
import { generateAuthToken } from './auth'
import { maskEmail } from './mask-email'
import { logger } from './logger'
import { sendAccountsMergedEmail, sendStaffMergeConfirmEmail } from './email'
import { ChapterAuditAction, StaffMergeGate } from '@/generated/prisma/enums'

/**
 * Staff merges of two accounts (admin.volunteers.merge). Only the same confirmed mailbox proves
 * one person holds both (`sameConfirmedMailbox`), and then the merge runs at once. Otherwise the
 * person proves it: each account's confirmed address is sent a link and the merge runs once both
 * are followed. Where an address is unconfirmed, a second global admin approves instead. The kept
 * account always keeps its own address and password, so nobody signs in to another's account.
 */

/** How long the people or the second admin have to answer. */
export const STAFF_MERGE_TTL_MS = 7 * 24 * 60 * 60 * 1000

type Account = { id: number; name: string; email: string | null; emailConfirmed: boolean }

const ACCOUNT = { id: true, name: true, email: true, emailConfirmed: true } as const

/**
 * Runs the merge, keeping the kept account's own sign-in. Inside its locked transaction it checks
 * again that the pair is not on record as two people and, for a direct merge, that the two still
 * share a confirmed mailbox, and writes ACCOUNT_MERGED under the chapter the kept account ends in.
 * Each confirmed address is then told once.
 */
export async function finishStaffMerge(
  kept: Account,
  merged: Account,
  actorId: number,
  proof: { mailbox: true } | { gate: StaffMergeGate; approvedById?: number },
) {
  const [volunteerAId, volunteerBId] = [kept.id, merged.id].sort((x, y) => x - y)
  const { signInEmail } = await mergeAccounts(kept.id, merged.id, actorId, 'kept', {
    check: async (tx) => {
      if (await tx.distinctAccountPair.count({ where: { volunteerAId, volunteerBId } })) {
        throw new ORPCError('BAD_REQUEST', {
          message: 'These accounts are on record as two different people',
        })
      }
      if ('mailbox' in proof) {
        const [a, b] = await Promise.all(
          [kept.id, merged.id].map((id) =>
            tx.volunteer.findUniqueOrThrow({ where: { id }, select: ACCOUNT }),
          ),
        )
        if (!sameConfirmedMailbox(a, b)) {
          throw new ORPCError('BAD_REQUEST', {
            message: 'These accounts no longer share a mailbox',
          })
        }
      }
    },
    after: async (tx) => {
      const after = await tx.volunteer.findUniqueOrThrow({
        where: { id: kept.id },
        select: { nationalChapterId: true },
      })
      await audit(tx, ChapterAuditAction.ACCOUNT_MERGED, {
        actorId,
        chapterId: after.nationalChapterId,
        targetVolunteerId: kept.id,
        details: { mergedId: merged.id, ...proof },
      })
    },
  })
  const masked = signInEmail ? maskEmail(signInEmail) : null
  for (const to of mailboxesOf(kept, merged)) {
    await sendAccountsMergedEmail({ to, name: kept.name, signInWith: masked }).catch((e) =>
      logger.error(e, '[MERGE] Email to a merged address failed'),
    )
  }
}

/**
 * Each confirmed address once, the kept account's first: an unconfirmed one may not be the
 * person's, and two addresses can deliver to the same mailbox.
 */
function mailboxesOf(...accounts: Account[]): string[] {
  const mailboxes = new Map<string, string>()
  for (const a of accounts) {
    const key = mailboxKey(a.email)
    if (a.email && a.emailConfirmed && key && !mailboxes.has(key)) mailboxes.set(key, a.email)
  }
  return [...mailboxes.values()]
}

/** A merge waiting on either account, still open. */
export function openRequestFor(volunteerId: number) {
  return prisma.staffMergeRequest.findFirst({
    where: {
      settledAt: null,
      expiresAt: { gt: new Date() },
      OR: [{ keptId: volunteerId }, { mergedId: volunteerId }],
    },
    include: {
      kept: { select: { id: true, name: true } },
      merged: { select: { id: true, name: true } },
      requestedBy: { select: { id: true, name: true } },
    },
  })
}

/**
 * Asks for proof before merging two accounts: the person, at both addresses, when both are
 * confirmed; otherwise a second global admin, which only a global admin may ask for. The account
 * kept keeps its own sign-in, so it must be the one whose address is confirmed, if only one is.
 * One request waits per account.
 */
export async function requestStaffMerge(
  kept: Account,
  merged: Account,
  requestedBy: { id: number; globalAdmin: boolean },
) {
  const mailed = kept.emailConfirmed && merged.emailConfirmed
  if (!mailed && !requestedBy.globalAdmin) {
    throw new ORPCError('BAD_REQUEST', {
      message:
        'Both accounts need a confirmed address before they can be asked; a global admin can merge them otherwise',
    })
  }
  if (!kept.emailConfirmed && merged.emailConfirmed) {
    throw new ORPCError('BAD_REQUEST', {
      message: `Keep the account whose address is confirmed: ${merged.name}'s`,
    })
  }
  for (const a of [kept, merged]) {
    if (await openRequestFor(a.id)) {
      throw new ORPCError('BAD_REQUEST', {
        message: `${a.name} already has a merge waiting for an answer`,
      })
    }
  }
  const gate = mailed ? StaffMergeGate.MAILBOXES : StaffMergeGate.SECOND_ADMIN
  const request = await prisma.staffMergeRequest.create({
    data: {
      keptId: kept.id,
      mergedId: merged.id,
      requestedById: requestedBy.id,
      gate,
      expiresAt: new Date(Date.now() + STAFF_MERGE_TTL_MS),
      ...(gate === StaffMergeGate.MAILBOXES && {
        keptToken: generateAuthToken(),
        mergedToken: generateAuthToken(),
      }),
    },
  })
  if (gate === StaffMergeGate.MAILBOXES) {
    for (const [account, token] of [
      [kept, request.keptToken],
      [merged, request.mergedToken],
    ] as const) {
      await sendStaffMergeConfirmEmail({
        to: account.email as string,
        name: account.name,
        token: token as string,
      })
    }
  }
  return gate
}

/**
 * Records that the person followed the link sent to one of the two addresses; once both are, the
 * merge runs, as asked for by the admin who requested it. Says which happened.
 */
export async function confirmStaffMerge(token: string): Promise<'waiting' | 'merged'> {
  const request = await prisma.staffMergeRequest.findFirst({
    where: { OR: [{ keptToken: token }, { mergedToken: token }] },
    include: { kept: { select: ACCOUNT }, merged: { select: ACCOUNT } },
  })
  if (!request || request.settledAt || request.expiresAt <= new Date()) {
    throw new ORPCError('BAD_REQUEST', { message: 'This link has expired or was already used' })
  }
  const side = request.keptToken === token ? 'keptConfirmedAt' : 'mergedConfirmedAt'
  // Claimed only while open, so of two clicks at once one finishes the merge.
  const now = new Date()
  const updated = await prisma.staffMergeRequest.updateMany({
    where: { id: request.id, settledAt: null, [side]: null },
    data: { [side]: now },
  })
  // A second click on the same link changes nothing; the other link finishes it.
  if (!updated.count) return 'waiting'
  // Settled by whichever confirmation completes the pair, once.
  const settled = await prisma.staffMergeRequest.updateMany({
    where: {
      id: request.id,
      settledAt: null,
      keptConfirmedAt: { not: null },
      mergedConfirmedAt: { not: null },
    },
    data: { settledAt: now },
  })
  if (!settled.count) return 'waiting'
  await finishStaffMerge(request.kept, request.merged, request.requestedById ?? request.keptId, {
    gate: StaffMergeGate.MAILBOXES,
  })
  return 'merged'
}

/** A second global admin, not the one who asked, approves a merge waiting on one. */
export async function approveStaffMerge(id: number, approverId: number) {
  const request = await prisma.staffMergeRequest.findUnique({
    where: { id },
    include: { kept: { select: ACCOUNT }, merged: { select: ACCOUNT } },
  })
  if (!request || request.gate !== StaffMergeGate.SECOND_ADMIN) {
    throw new ORPCError('NOT_FOUND', { message: 'Request not found' })
  }
  if (request.requestedById === approverId) {
    throw new ORPCError('BAD_REQUEST', { message: 'Another global admin must approve it' })
  }
  const settled = await prisma.staffMergeRequest.updateMany({
    where: { id, settledAt: null, expiresAt: { gt: new Date() } },
    data: { settledAt: new Date(), approvedById: approverId },
  })
  if (!settled.count) {
    throw new ORPCError('BAD_REQUEST', { message: 'This request has expired or was answered' })
  }
  await finishStaffMerge(request.kept, request.merged, approverId, {
    gate: StaffMergeGate.SECOND_ADMIN,
    approvedById: approverId,
  })
  return request
}

/** Takes back a merge nobody has finished. */
export async function withdrawStaffMerge(id: number) {
  const { count } = await prisma.staffMergeRequest.updateMany({
    where: { id, settledAt: null },
    data: { settledAt: new Date() },
  })
  if (!count) throw new ORPCError('BAD_REQUEST', { message: 'This request was already answered' })
}

/**
 * A merge of `volunteerId` waiting for proof, as their profile shows it to a global admin or
 * lead, with what `viewer` may do about it; null when none waits.
 */
export async function pendingMergeView(
  volunteerId: number,
  viewer: { id: number; globalAdmin: boolean },
) {
  const open = await openRequestFor(volunteerId)
  if (!open) return null
  return {
    id: open.id,
    keptName: open.kept.name,
    mergedName: open.merged.name,
    gate: open.gate,
    requestedByName: open.requestedBy?.name ?? null,
    canApprove:
      viewer.globalAdmin &&
      open.gate === StaffMergeGate.SECOND_ADMIN &&
      open.requestedById !== viewer.id,
    canWithdraw: viewer.globalAdmin,
  }
}
