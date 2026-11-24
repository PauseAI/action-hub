import { bulkCapRefusals } from '@/lib/email-transport'
import { prisma } from '@/lib/prisma'

/**
 * Fails while EMAIL_HOURLY_CAP (GuardedTransport) has refused mail this hour or last, so the
 * cron trigger pings its healthcheck's /fail and the refusal reaches a person. It runs after the
 * trigger's other jobs, so it sees the mail they sent.
 */
export async function runEmailCapCheckJob(now: Date = new Date()) {
  const reached = await bulkCapRefusals(prisma, now)
  if (reached.length) throw new Error(`Email held back: ${reached.join('; ')}`)
  return { reached: 0 }
}
