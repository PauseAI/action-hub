import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { prisma } from './prisma'
import { hashEmail } from './auth'
import { capsReached, EmailTransport, GuardedTransport } from './email-transport'
import { liftSuppression, suppressAddresses, suppressionKey } from './email-suppression'
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

  it('keeps essential mail out of the bulk cap, under a cap and a per-recipient limit of its own', async () => {
    vi.stubEnv('EMAIL_HOURLY_CAP', '1')
    vi.stubEnv('EMAIL_ESSENTIAL_HOURLY_CAP', '7')
    vi.spyOn(logger, 'error').mockImplementation(() => logger as never)
    const essential = (address: string) => ({ ...to(address), essential: true })
    expect(await guarded.send(essential('reset@example.com'))).toBe(true)
    // Essential mail took none of the bulk allowance.
    expect(await guarded.send(to('bulk1@example.com'))).toBe(true)
    expect(await guarded.send(to('bulk2@example.com'))).toBe(false)
    // Five an hour to one address, however it is written.
    for (const n of [2, 3, 4, 5])
      expect(await guarded.send(essential('reset@example.com')), `${n}`).toBe(true)
    expect(await guarded.send(essential('Reset@Example.com'))).toBe(false)
    expect(await guarded.send(essential('other@example.com'))).toBe(true)
    // Seven essential emails in all, then no more this hour.
    expect(await guarded.send(essential('third@example.com'))).toBe(true)
    expect(await guarded.send(essential('fourth@example.com'))).toBe(false)
    expect(emails.to('reset@example.com')).toHaveLength(5)
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
    vi.spyOn(prisma.emailSuppression, 'findFirst').mockRejectedValueOnce(new Error('db down'))
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

  it('without suppression, as for Resend, sends to a listed address and still caps', async () => {
    const resendLike = new GuardedTransport(emails, { suppression: false })
    vi.stubEnv('EMAIL_HOURLY_CAP', '1')
    vi.spyOn(logger, 'error').mockImplementation(() => logger as never)
    await suppressAddresses(['listed@example.com'], 'bounce', null)
    expect(await resendLike.send(to('listed@example.com'))).toBe(true)
    expect(await resendLike.send(to('next@example.com'))).toBe(false)
    expect(emails.sent.map((e) => e.to)).toEqual(['listed@example.com'])
  })

  it('limits essential mail per recipient without the hashing secret', async () => {
    vi.stubEnv('EMAIL_HASH_SECRET', '')
    vi.spyOn(logger, 'error').mockImplementation(() => logger as never)
    const resendLike = new GuardedTransport(emails, { suppression: false })
    const reset = { ...to('reset@example.com'), essential: true }
    for (let n = 0; n < 5; n++) expect(await resendLike.send(reset)).toBe(true)
    expect(await resendLike.send({ ...reset, to: ' Reset@Example.com' })).toBe(false)
  })

  it('reports whether the provider inside it is configured', () => {
    emails.setConfigured(false)
    expect(guarded.configured()).toBe(false)
    emails.setConfigured(true)
    expect(guarded.configured()).toBe(true)
  })
})

describe('capsReached', () => {
  const at = (iso: string) => new Date(iso)

  it('names each shared cap that refused mail this hour or last, and nothing older', async () => {
    await prisma.emailSendCount.createMany({
      data: [
        { hour: at('2026-11-24T08:00:00Z'), bucket: 'bulk:refused', count: 50 },
        { hour: at('2026-11-24T09:00:00Z'), bucket: 'bulk', count: 500 },
        { hour: at('2026-11-24T09:00:00Z'), bucket: 'bulk:refused', count: 11 },
        { hour: at('2026-11-24T10:00:00Z'), bucket: 'essential:refused', count: 1 },
        { hour: at('2026-11-24T10:00:00Z'), bucket: 'to:someone', count: 9 },
      ],
    })
    expect(await capsReached(prisma, at('2026-11-24T10:00:30Z'))).toEqual([
      'EMAIL_HOURLY_CAP refused 11 in the hour from 2026-11-24T09:00:00.000Z',
      'EMAIL_ESSENTIAL_HOURLY_CAP refused 1 in the hour from 2026-11-24T10:00:00.000Z',
    ])
    expect(await capsReached(prisma, at('2026-11-24T11:59:00Z'))).toEqual([
      'EMAIL_ESSENTIAL_HOURLY_CAP refused 1 in the hour from 2026-11-24T10:00:00.000Z',
    ])
    expect(await capsReached(prisma, at('2026-11-24T12:00:00Z'))).toEqual([])
  })

  it('sees a refusal, even after a failed send gives its slot back', async () => {
    vi.stubEnv('EMAIL_HOURLY_CAP', '1')
    vi.spyOn(logger, 'error').mockImplementation(() => logger as never)
    // The first send holds the one slot; the second is refused; then the first fails.
    let release!: (ok: boolean) => void
    const slow = new GuardedTransport(
      new (class extends EmailTransport {
        send() {
          return new Promise<boolean>((resolve) => (release = resolve))
        }
      })(),
    )
    const first = slow.send(to('a@example.com'))
    await vi.waitFor(() => expect(release).toBeDefined())
    expect(await capsReached(prisma, new Date())).toEqual([])
    expect(await slow.send(to('b@example.com'))).toBe(false)
    release(false)
    expect(await first).toBe(false)
    expect(await capsReached(prisma, new Date())).toEqual([
      expect.stringContaining('EMAIL_HOURLY_CAP refused 1'),
    ])
  })

  it('does not count a per-recipient refusal as a shared cap reached', async () => {
    vi.spyOn(logger, 'error').mockImplementation(() => logger as never)
    const reset = { ...to('reset@example.com'), essential: true }
    for (let n = 0; n < 6; n++) await guarded.send(reset)
    expect(emails.to('reset@example.com')).toHaveLength(5)
    expect(await capsReached(prisma, new Date())).toEqual([])
  })
})

describe('suppressAddresses', () => {
  it('stores each address once under a keyed hash, in any case, ignoring blanks', async () => {
    await suppressAddresses([' A@Example.com', 'a@example.com', ' '], 'bounce', 'Permanent')
    const rows = await prisma.emailSuppression.findMany({ select: { emailHash: true } })
    expect(rows).toEqual([{ emailHash: suppressionKey('a@example.com') }])
    // Not the plain SHA-256 that anyone holding a list of addresses could recompute.
    expect(rows[0].emailHash).not.toBe(hashEmail('a@example.com'))
    vi.stubEnv('EMAIL_HASH_SECRET', 'another-secret')
    expect(suppressionKey('a@example.com')).not.toBe(rows[0].emailHash)
  })

  it('lets a complaint lapse after a year, keeps a bounce, and lifts either on request', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-01-01T00:00:00Z') })
    await suppressAddresses(['c@example.com'], 'complaint', 'abuse')
    await suppressAddresses(['b@example.com'], 'bounce', 'Permanent/General')
    expect(await guarded.send(to('c@example.com'))).toBe(false)
    vi.setSystemTime(new Date('2027-01-02T00:00:00Z'))
    expect(await guarded.send(to('c@example.com'))).toBe(true)
    expect(await guarded.send(to('b@example.com'))).toBe(false)
    // A new complaint after the old one lapsed suppresses again.
    await suppressAddresses(['c@example.com'], 'complaint', 'abuse')
    expect(await guarded.send(to('c@example.com'))).toBe(false)
    await liftSuppression('B@example.com')
    expect(await guarded.send(to('b@example.com'))).toBe(true)
  })

  it('refuses to key an address without the secret, and has nothing to lift', async () => {
    vi.stubEnv('EMAIL_HASH_SECRET', '')
    expect(() => suppressionKey('a@example.com')).toThrow('EMAIL_HASH_SECRET')
    // Resend runs with no secret and no suppressions: deleting an account must still work.
    await expect(liftSuppression('a@example.com')).resolves.toBeUndefined()
  })
})
