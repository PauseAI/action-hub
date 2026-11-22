import { describe, it, expect } from 'vitest'
import { prisma } from '@/lib/prisma'
import { runEmailHousekeepingJob } from './email-housekeeping'

describe('email housekeeping', () => {
  it('drops send counts and SNS message ids over a day old, and keeps the rest', async () => {
    const hoursAgo = (n: number) => new Date(Date.now() - n * 60 * 60 * 1000)
    const [old, recent] = [hoursAgo(25), hoursAgo(1)]
    await prisma.emailSendCount.createMany({
      data: [
        { hour: old, bucket: 'bulk', count: 3 },
        { hour: recent, bucket: 'bulk', count: 4 },
      ],
    })
    await prisma.snsMessage.createMany({
      data: [
        { messageId: 'old', receivedAt: old },
        { messageId: 'recent', receivedAt: recent },
      ],
    })
    expect(await runEmailHousekeepingJob()).toEqual({ sendCounts: 1, snsMessages: 1 })
    expect(await prisma.emailSendCount.findMany({ select: { hour: true } })).toEqual([
      { hour: recent },
    ])
    expect(await prisma.snsMessage.findMany({ select: { messageId: true } })).toEqual([
      { messageId: 'recent' },
    ])
  })
})
