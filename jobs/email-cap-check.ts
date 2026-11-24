import { capsReached } from '@/lib/email-transport'
import { prisma } from '@/lib/prisma'

/**
 * Fails while an email cap (GuardedTransport) has refused mail this hour or last, so the cron
 * trigger pings its healthcheck's /fail and the refusal reaches a person.
 */
export async function runEmailCapCheckJob(now: Date = new Date()) {
  const reached = await capsReached(prisma, now)
  if (reached.length) throw new Error(`Email held back: ${reached.join('; ')}`)
  return { reached: 0 }
}
