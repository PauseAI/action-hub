import { beforeEach, describe, it, expect } from 'vitest'
import { prisma } from '@/lib/prisma'
import { runEmailCapCheckJob } from './email-cap-check'

beforeEach(async () => {
  await prisma.emailSendCount.deleteMany()
})

describe('email cap check', () => {
  it('passes while every cap held, and fails naming the cap once one refused mail', async () => {
    const now = new Date('2026-11-24T10:05:00Z')
    const hour = new Date('2026-11-24T10:00:00Z')
    await prisma.emailSendCount.create({ data: { hour, bucket: 'bulk', count: 3 } })
    expect(await runEmailCapCheckJob(now)).toEqual({ reached: 0 })

    await prisma.emailSendCount.create({ data: { hour, bucket: 'bulk:refused', count: 2 } })
    await expect(runEmailCapCheckJob(now)).rejects.toThrow(
      'Email held back: EMAIL_HOURLY_CAP refused 2 in the hour from 2026-11-24T10:00:00.000Z',
    )
  })
})
