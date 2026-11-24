import { beforeEach, describe, it, expect, vi, afterEach } from 'vitest'
import { prisma } from '@/lib/prisma'
import { runEmailCapCheckJob } from './email-cap-check'

beforeEach(async () => {
  await prisma.emailSendCount.deleteMany()
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('email cap check', () => {
  it('passes while every cap held, and fails naming the cap once one refused mail', async () => {
    vi.stubEnv('EMAIL_HOURLY_CAP', '3')
    const now = new Date('2026-11-24T10:05:00Z')
    const hour = new Date('2026-11-24T10:00:00Z')
    await prisma.emailSendCount.create({ data: { hour, bucket: 'bulk', count: 3 } })
    expect(await runEmailCapCheckJob(now)).toEqual({ reached: 0 })

    await prisma.emailSendCount.update({
      where: { hour_bucket: { hour, bucket: 'bulk' } },
      data: { count: 4 },
    })
    await expect(runEmailCapCheckJob(now)).rejects.toThrow(
      'Email held back: EMAIL_HOURLY_CAP of 3 reached in the hour from 2026-11-24T10:00:00.000Z (4 tried)',
    )
  })
})
