import { createHmac } from 'node:crypto'
import type { EmailSuppressionReason } from '@/generated/prisma/enums'
import { env } from './env'
import { prisma } from './prisma'

/** A complaint lapses after a year; a hard bounce stays until lifted, as SES keeps it. */
const COMPLAINT_SUPPRESSION_MS = 365 * 24 * 60 * 60 * 1000

/**
 * The keyed hash an address is suppressed under. Keyed, so the table cannot be checked against
 * a list of addresses by anyone without EMAIL_HASH_SECRET.
 */
export function suppressionKey(address: string): string {
  const secret = env.EMAIL_HASH_SECRET
  if (!secret) throw new Error('EMAIL_HASH_SECRET is not set')
  return createHmac('sha256', secret).update(address.trim().toLowerCase()).digest('hex')
}

/** The reason mail to `address` is held back, or null when it may be sent. */
export async function suppressionOf(address: string): Promise<EmailSuppressionReason | null> {
  const row = await prisma.emailSuppression.findFirst({
    where: {
      emailHash: suppressionKey(address),
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
    },
    select: { reason: true },
  })
  return row?.reason ?? null
}

/**
 * Stops mail to `addresses`. A bounce makes a suppression permanent; a complaint suppresses for
 * a year, or renews a complaint already there, but never shortens a bounce's.
 */
export async function suppressAddresses(
  addresses: string[],
  reason: EmailSuppressionReason,
  detail: string | null,
): Promise<void> {
  const now = new Date()
  const expiresAt =
    reason === 'complaint' ? new Date(now.getTime() + COMPLAINT_SUPPRESSION_MS) : null
  const data = { reason, detail, createdAt: now, expiresAt }
  const keys = [...new Set(addresses.filter((a) => a.trim()).map(suppressionKey))]
  for (const emailHash of keys) {
    await prisma.emailSuppression.updateMany({
      where: { emailHash, ...(reason === 'complaint' && { expiresAt: { not: null } }) },
      data,
    })
  }
  await prisma.emailSuppression.createMany({
    data: keys.map((emailHash) => ({ emailHash, ...data })),
    skipDuplicates: true,
  })
}

/** Lets mail reach `address` again, as when its account is deleted. */
export async function liftSuppression(address: string): Promise<void> {
  if (!env.EMAIL_HASH_SECRET) return
  await prisma.emailSuppression.deleteMany({ where: { emailHash: suppressionKey(address) } })
}
