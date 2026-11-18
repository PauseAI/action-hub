import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { suppressionKey } from '@/lib/email-suppression'
import { sendPasswordResetEmail } from '@/lib/email'
import { GuardedTransport, setEmailTransport } from '@/lib/email-transport'
import { emails } from '@/test/fakes/email'
import { CERT_URL, TOPIC_ARN, sesBounce, sesComplaint, sns } from '@/test/fakes/sns'
import { POST } from './route'

afterEach(() => vi.unstubAllEnvs())

beforeEach(async () => {
  await prisma.emailSuppression.deleteMany()
  await prisma.snsMessage.deleteMany()
  vi.stubEnv('SES_FEEDBACK_TOPIC_ARN', TOPIC_ARN)
})

const post = (body: unknown) =>
  POST(
    new NextRequest('http://localhost/api/email/sns', {
      method: 'POST',
      headers: { 'content-type': 'text/plain; charset=UTF-8' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
  )

/** Suppressions, by the address each is for out of `candidates`, sorted by address. */
async function suppressed(candidates = ADDRESSES) {
  const rows = await prisma.emailSuppression.findMany()
  return candidates.flatMap((email) => {
    const row = rows.find((r) => r.emailHash === suppressionKey(email))
    return row ? [{ email, reason: row.reason, detail: row.detail }] : []
  })
}

const ADDRESSES = [
  'a@example.com',
  'b@example.com',
  'full@example.com',
  'gone@example.com',
  'someone-else@example.com',
  'v@example.com',
  'v1@example.com',
  'victim@example.com',
]

describe('SNS email events', () => {
  it('suppresses a permanently bounced address, and mail to it stops', async () => {
    const res = await post(sns.notification(sesBounce(['Gone@Example.com'])))
    expect(res.status).toBe(200)
    expect(await suppressed()).toEqual([
      {
        email: 'gone@example.com',
        reason: 'bounce',
        detail: 'Permanent/General',
      },
    ])

    // As production sends: the provider wrapped in GuardedTransport.
    setEmailTransport(new GuardedTransport(emails))
    try {
      await sendPasswordResetEmail({ to: 'gone@example.com', resetToken: 't', name: 'G' })
      await sendPasswordResetEmail({ to: 'GONE@example.com ', resetToken: 't', name: 'G' })
      await sendPasswordResetEmail({ to: 'here@example.com', resetToken: 't', name: 'H' })
    } finally {
      setEmailTransport(emails)
    }
    expect(emails.sent.map((e) => e.to)).toEqual(['here@example.com'])
  })

  it('never shortens a bounce with a later complaint', async () => {
    await post(sns.notification(sesBounce(['a@example.com'])))
    await post(sns.notification(sesComplaint(['a@example.com'])))
    expect(await suppressed()).toEqual([
      { email: 'a@example.com', reason: 'bounce', detail: 'Permanent/General' },
    ])
    expect((await prisma.emailSuppression.findFirstOrThrow()).expiresAt).toBeNull()
  })

  it('suppresses complainers for a year, a later bounce for good, and ignores transient bounces', async () => {
    await post(sns.notification(sesComplaint(['a@example.com', 'b@example.com'])))
    await post(sns.notification(sesBounce(['a@example.com'])))
    await post(sns.notification(sesBounce(['full@example.com'], 'Transient')))
    expect(await suppressed()).toEqual([
      { email: 'a@example.com', reason: 'bounce', detail: 'Permanent/General' },
      { email: 'b@example.com', reason: 'complaint', detail: 'abuse' },
    ])
    const rows = await prisma.emailSuppression.findMany({ orderBy: { reason: 'asc' } })
    expect(rows[0].expiresAt).toBeNull()
    const year = rows[1].expiresAt!.getTime() - rows[1].createdAt.getTime()
    expect(Math.round(year / 86_400_000)).toBe(365)
  })

  it('does not suppress someone whose complaint says the mail was not spam', async () => {
    const complaint = sesComplaint(['a@example.com']) as { complaint: object }
    complaint.complaint = { ...complaint.complaint, complaintFeedbackType: 'not-spam' }
    expect((await post(sns.notification(complaint))).status).toBe(200)
    expect(await prisma.emailSuppression.count()).toBe(0)
  })

  it('accepts a message with a Subject, but only SignatureVersion 2', async () => {
    const subject = { Subject: 'Amazon SES Email Event Notification' }
    const v1 = sns.notification(sesBounce(['v1@example.com']), {
      ...subject,
      SignatureVersion: '1',
    })
    expect((await post(v1)).status).toBe(403)
    const v2 = sns.notification(sesBounce(['v1@example.com']), subject)
    expect((await post(v2)).status).toBe(200)
    expect((await suppressed()).map((s) => s.email)).toEqual(['v1@example.com'])
  })

  it('handles a message once, however often it is delivered or replayed', async () => {
    const message = sns.notification(sesBounce(['v@example.com']))
    expect((await post(message)).status).toBe(200)
    await prisma.emailSuppression.deleteMany()
    expect((await post(message)).status).toBe(200)
    expect(await prisma.emailSuppression.count()).toBe(0)
  })

  it('refuses a message signed more than an hour ago, or in the future', async () => {
    const hour = 60 * 60 * 1000
    for (const offset of [-hour - 60_000, 10 * 60_000]) {
      const at = new Date(Date.now() + offset).toISOString()
      const res = await post(sns.notification(sesBounce(['v@example.com']), { Timestamp: at }))
      expect(res.status, at).toBe(403)
    }
    const garbled = sns.notification(sesBounce(['v@example.com']), { Timestamp: 'yesterday' })
    expect((await post(garbled)).status).toBe(403)
    const recent = new Date(Date.now() - hour + 60_000).toISOString()
    expect(
      (await post(sns.notification(sesBounce(['v@example.com']), { Timestamp: recent }))).status,
    ).toBe(200)
    expect(await prisma.emailSuppression.count()).toBe(1)
  })

  it('skips recipients without an address, and a complaint with no details', async () => {
    const bounce = sesBounce(['a@example.com']) as { bounce: { bouncedRecipients: object[] } }
    bounce.bounce.bouncedRecipients.push({ emailAddress: 42 }, {})
    expect((await post(sns.notification(bounce))).status).toBe(200)
    expect((await post(sns.notification({ eventType: 'Complaint' }))).status).toBe(200)
    expect(await suppressed()).toEqual([
      { email: 'a@example.com', reason: 'bounce', detail: 'Permanent/General' },
    ])
    expect(await prisma.emailSuppression.count()).toBe(1)
  })

  it('ignores event types it has no use for, such as deliveries', async () => {
    const res = await post(sns.notification({ eventType: 'Delivery', mail: {} }))
    expect(res.status).toBe(200)
    expect(await prisma.emailSuppression.count()).toBe(0)
  })

  it('confirms a subscription to an allowed topic by visiting its SubscribeURL', async () => {
    const message = sns.subscriptionConfirmation()
    expect((await post(message)).status).toBe(200)
    expect(sns.confirmed).toEqual([message.SubscribeURL])
    // An unsubscribe notice is acknowledged and nothing else.
    const unsubscribe = sns.signed({ ...message, Type: 'UnsubscribeConfirmation' })
    expect((await post(unsubscribe)).status).toBe(200)
    expect(sns.confirmed).toHaveLength(1)
  })

  it('refuses a forged notification: body changed after signing', async () => {
    const real = sns.notification(sesBounce(['victim@example.com']))
    const forged = { ...real, Message: JSON.stringify(sesBounce(['someone-else@example.com'])) }
    expect((await post(forged)).status).toBe(403)
    expect(await suppressed()).toEqual([])
  })

  it('refuses unsigned messages and signatures it cannot check', async () => {
    const real = sns.notification(sesBounce(['victim@example.com']))
    const { Signature: _, ...unsigned } = real
    expect((await post(unsigned)).status).toBe(403)
    expect((await post({ ...real, Signature: 'AAAA' })).status).toBe(403)
    expect((await post({ ...real, SignatureVersion: '3' })).status).toBe(403)
    expect(await suppressed()).toEqual([])
  })

  it('refuses a certificate that is not on an SNS host, without fetching it', async () => {
    for (const url of [
      'https://evil.example.com/cert.pem',
      'http://sns.eu-west-1.amazonaws.com/cert.pem',
      'https://sns.eu-west-1.amazonaws.com.evil.example/cert.pem',
      'https://sns.eu-west-1.amazonaws.com/cert.pem',
      'https://sns.eu-west-1.amazonaws.com/SimpleNotificationService-abc.pem/../x',
      'https://sns.eu-west-1.amazonaws.com/cert.txt',
      'not a url',
    ]) {
      const res = await post(
        sns.notification(sesBounce(['victim@example.com']), { SigningCertURL: url }),
      )
      expect(res.status, url).toBe(403)
    }
    expect(sns.certificatesFetched).toEqual([])
    // A well-formed SNS URL serving no certificate gets a 503, so SNS delivers it again later.
    const other = CERT_URL.replace('01d0', 'ffff')
    const res = await post(
      sns.notification(sesBounce(['v@example.com']), { SigningCertURL: other }),
    )
    expect(res.status).toBe(503)
    expect(await suppressed()).toEqual([])
  })

  it('refuses a correctly signed message from a topic it was not told to trust', async () => {
    const wrongTopic = 'arn:aws:sns:eu-west-1:999999999999:someone-elses-topic'
    const notification = sns.notification(sesBounce(['victim@example.com']), {
      TopicArn: wrongTopic,
    })
    expect((await post(notification)).status).toBe(403)
    const subscription = sns.subscriptionConfirmation({ TopicArn: wrongTopic })
    expect((await post(subscription)).status).toBe(403)
    expect(sns.confirmed).toEqual([])
    expect(sns.certificatesFetched).toEqual([])
    expect(await suppressed()).toEqual([])
  })

  it('trusts no topic at all until one is configured', async () => {
    vi.stubEnv('SES_FEEDBACK_TOPIC_ARN', '')
    expect((await post(sns.notification(sesBounce(['victim@example.com'])))).status).toBe(403)
    expect(await suppressed()).toEqual([])
  })

  it('refuses a SubscribeURL that is not an SNS endpoint', async () => {
    const message = sns.subscriptionConfirmation({ SubscribeURL: 'https://evil.example.com/hook' })
    expect((await post(message)).status).toBe(403)
    expect(sns.confirmed).toEqual([])
  })

  it('rejects bodies that are not an SNS message', async () => {
    expect((await post('not json')).status).toBe(400)
    expect((await post([1, 2])).status).toBe(400)
    expect((await post({ Type: 'Notification' })).status).toBe(400)
    expect((await post('x'.repeat(300_000))).status).toBe(413)
    // Streamed with no length given, it is cut off once it passes the limit.
    let pulled = 0
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled++
        controller.enqueue(new Uint8Array(64 * 1024))
      },
    })
    const init = { method: 'POST', body: endless, duplex: 'half' } as RequestInit
    const streamed = await POST(
      new NextRequest(new Request('http://localhost/api/email/sns', init)),
    )
    expect(streamed.status).toBe(413)
    expect(pulled).toBeLessThan(10)
    const empty = await POST(new NextRequest('http://localhost/api/email/sns', { method: 'POST' }))
    expect(empty.status).toBe(400)
  })

  it('answers 400 to a signed notification whose message is not SES JSON', async () => {
    const res = await post(sns.notification('plain text', { Message: 'plain text' }))
    expect(res.status).toBe(400)
  })
})
