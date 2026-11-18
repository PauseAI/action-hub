import { prisma } from '@/lib/prisma'

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Drops send counts for hours long past (the caps only read the current hour) and SNS message
 * ids too old to be accepted again (the route refuses anything over an hour old).
 */
export async function runEmailHousekeepingJob(now: Date = new Date()) {
  const cutoff = new Date(now.getTime() - DAY_MS)
  const counts = await prisma.emailSendCount.deleteMany({ where: { hour: { lt: cutoff } } })
  const messages = await prisma.snsMessage.deleteMany({ where: { receivedAt: { lt: cutoff } } })
  return { sendCounts: counts.count, snsMessages: messages.count }
}
