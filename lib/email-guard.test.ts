import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { prisma } from './prisma'
import { hashEmail } from './auth'
import { GuardedTransport } from './email-transport'
import { suppressAddresses } from './email-suppression'
import { logger } from './logger'
import { emails } from '@/test/fakes/email'

const guarded = new GuardedTransport(emails)
const to = (address: string) => ({ to: address, subject: 'Hi', html: '<p>hi</p>' })

beforeEach(async () => {
  await prisma.emailSuppression.deleteMany()
  await prisma.emailSendCount.deleteMany()
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('GuardedTransport', () => {
  it('stops at EMAIL_HOURLY_CAP sends in a clock hour and starts again the next hour', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-11-18T10:59:00Z') })
    vi.stubEnv('EMAIL_HOURLY_CAP', '2')
    const error = vi.spyOn(logger, 'error').mockImplementation(() => logger as never)

    const results = []
    for (const n of [1, 2, 3, 4]) results.push(await guarded.send(to(`p${n}@example.com`)))
    expect(results).toEqual([true, true, false, false])
    expect(emails.sent.map((e) => e.to)).toEqual(['p1@example.com', 'p2@example.com'])
    // Said loudly once when the cap is reached, not once per refused email.
    expect(error).toHaveBeenCalledTimes(1)
    expect(error.mock.calls[0][1]).toContain('EMAIL_HOURLY_CAP')

    vi.setSystemTime(new Date('2026-11-18T11:00:00Z'))
    expect(await guarded.send(to('p5@example.com'))).toBe(true)
  })

  it('holds the cap when many sends race, as a fan-out across processes would', async () => {
    vi.stubEnv('EMAIL_HOURLY_CAP', '3')
    vi.spyOn(logger, 'error').mockImplementation(() => logger as never)
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, n) => guarded.send(to(`r${n}@example.com`))),
    )
    expect(results.filter(Boolean)).toHaveLength(3)
    expect(emails.sent).toHaveLength(3)
  })

  it('refuses everything when the cap is 0, and falls back to the default for nonsense', async () => {
    vi.spyOn(logger, 'error').mockImplementation(() => logger as never)
    vi.stubEnv('EMAIL_HOURLY_CAP', '0')
    expect(await guarded.send(to('z@example.com'))).toBe(false)
    vi.stubEnv('EMAIL_HOURLY_CAP', 'lots')
    expect(await guarded.send(to('z@example.com'))).toBe(true)
  })

  it('sends nothing to a suppressed address, however it is written, and spends no cap on it', async () => {
    vi.stubEnv('EMAIL_HOURLY_CAP', '1')
    await suppressAddresses(['blocked@example.com'], 'complaint', null)
    expect(await guarded.send(to('blocked@example.com'))).toBe(false)
    expect(await guarded.send(to(' Blocked@Example.COM'))).toBe(false)
    expect(await guarded.send(to('ok@example.com'))).toBe(true)
    expect(emails.sent.map((e) => e.to)).toEqual(['ok@example.com'])
  })

  it('sends essential mail past the cap, still counting it', async () => {
    vi.stubEnv('EMAIL_HOURLY_CAP', '1')
    vi.spyOn(logger, 'error').mockImplementation(() => logger as never)
    expect(await guarded.send(to('bulk1@example.com'))).toBe(true)
    expect(await guarded.send(to('bulk2@example.com'))).toBe(false)
    expect(await guarded.send({ ...to('reset@example.com'), essential: true })).toBe(true)
    expect(emails.sent.map((e) => e.to)).toEqual(['bulk1@example.com', 'reset@example.com'])
  })

  it('gives a failed send its slot back, so an outage does not use up the hour', async () => {
    vi.stubEnv('EMAIL_HOURLY_CAP', '1')
    vi.spyOn(logger, 'error').mockImplementation(() => logger as never)
    emails.failNext(3)
    for (const n of [1, 2, 3]) expect(await guarded.send(to(`f${n}@example.com`))).toBe(false)
    expect(await guarded.send(to('ok@example.com'))).toBe(true)
    expect(emails.sent.map((e) => e.to)).toEqual(['ok@example.com'])
  })

  it('sends nothing when the database cannot say whether it may', async () => {
    const error = vi.spyOn(logger, 'error').mockImplementation(() => logger as never)
    vi.spyOn(prisma.emailSuppression, 'findUnique').mockRejectedValueOnce(new Error('db down'))
    expect(await guarded.send(to('a@example.com'))).toBe(false)
    expect(emails.sent).toEqual([])
    expect(error.mock.calls[0][1]).toContain('not sending')
  })

  it('still reports a send whose slot could not be given back as unsent', async () => {
    const error = vi.spyOn(logger, 'error').mockImplementation(() => logger as never)
    vi.spyOn(prisma.emailSendCount, 'updateMany').mockRejectedValueOnce(new Error('db down'))
    emails.failNext()
    expect(await guarded.send(to('a@example.com'))).toBe(false)
    expect(error).toHaveBeenCalledWith(
      expect.any(Error),
      '[EMAIL ERROR] Could not return a send slot',
    )
  })

  it('reports whether the provider inside it is configured', () => {
    emails.setConfigured(false)
    expect(guarded.configured()).toBe(false)
    emails.setConfigured(true)
    expect(guarded.configured()).toBe(true)
  })
})

describe('suppressAddresses', () => {
  it('stores each address once, hashed as typed in any case, ignoring blanks', async () => {
    await suppressAddresses([' A@Example.com', 'a@example.com', ' '], 'bounce', 'Permanent')
    expect(await prisma.emailSuppression.findMany({ select: { emailHash: true } })).toEqual([
      { emailHash: hashEmail('a@example.com') },
    ])
  })
})
