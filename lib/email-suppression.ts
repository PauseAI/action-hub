import type { EmailSuppressionReason } from '@/generated/prisma/enums'
import { hashEmail } from './auth'
import { prisma } from './prisma'

/** Stops all mail to `addresses` (see GuardedTransport). An address keeps its first reason. */
export async function suppressAddresses(
  addresses: string[],
  reason: EmailSuppressionReason,
  detail: string | null,
): Promise<void> {
  const hashes = new Set(addresses.filter((a) => a.trim()).map(hashEmail))
  await prisma.emailSuppression.createMany({
    data: [...hashes].map((emailHash) => ({ emailHash, reason, detail })),
    skipDuplicates: true,
  })
}
