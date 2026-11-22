import { generateKeyPairSync, randomUUID, sign } from 'node:crypto'
import { SnsGateway, snsStringToSign, type SnsMessage } from '@/lib/sns'

export const TOPIC_ARN = 'arn:aws:sns:eu-west-1:123456789012:ses-action-hub-feedback'
export const CERT_URL =
  'https://sns.eu-west-1.amazonaws.com/SimpleNotificationService-01d088a6a3f3e5a1c9f6b8e2a7d4c3b0.pem'

/**
 * Stands in for Amazon SNS: signs messages with a key generated per process and serves its
 * public half as the signing certificate at `CERT_URL`, so the route's signature check runs for
 * real. A message signed by any other key, or pointing at any other certificate, fails it.
 * `test/setup-db.ts` installs one per test file and resets it before each test.
 */
export class FakeSns extends SnsGateway {
  private readonly keys = generateKeyPairSync('rsa', { modulusLength: 2048 })
  /** Subscribe URLs the route visited to confirm a subscription. */
  readonly confirmed: string[] = []
  /** Certificate URLs the route asked for. */
  readonly certificatesFetched: string[] = []

  async certificate(url: string): Promise<string> {
    this.certificatesFetched.push(url)
    if (url !== CERT_URL) throw new Error(`no certificate at ${url}`)
    return this.keys.publicKey.export({ type: 'spki', format: 'pem' }).toString()
  }

  async confirm(subscribeUrl: string): Promise<void> {
    this.confirmed.push(subscribeUrl)
  }

  /** A notification as SNS would POST it, each with its own MessageId unless one is given. */
  notification(message: unknown, overrides: Partial<SnsMessage> = {}): SnsMessage {
    return this.signed({
      Type: 'Notification',
      MessageId: randomUUID(),
      TopicArn: TOPIC_ARN,
      Message: JSON.stringify(message),
      Timestamp: new Date().toISOString(),
      SignatureVersion: '2',
      SigningCertURL: CERT_URL,
      ...overrides,
    })
  }

  subscriptionConfirmation(overrides: Partial<SnsMessage> = {}): SnsMessage {
    return this.signed({
      Type: 'SubscriptionConfirmation',
      MessageId: randomUUID(),
      TopicArn: TOPIC_ARN,
      Token: 'token-1',
      Message: 'You have chosen to subscribe to the topic',
      SubscribeURL: `https://sns.eu-west-1.amazonaws.com/?Action=ConfirmSubscription&TopicArn=${TOPIC_ARN}&Token=token-1`,
      Timestamp: new Date().toISOString(),
      SignatureVersion: '2',
      SigningCertURL: CERT_URL,
      ...overrides,
    })
  }

  /** Signs `fields` with this fake's key; a field set afterwards is a forgery. */
  signed(fields: Omit<SnsMessage, 'Signature'>): SnsMessage {
    const algorithm = fields.SignatureVersion === '1' ? 'sha1' : 'sha256'
    const body = Buffer.from(snsStringToSign(fields as SnsMessage))
    const signature = sign(algorithm, body, this.keys.privateKey).toString('base64')
    return { ...fields, Signature: signature } as SnsMessage
  }

  reset(): void {
    this.confirmed.length = 0
    this.certificatesFetched.length = 0
  }
}

export const sns = new FakeSns()

/** An SES bounce event as a configuration set publishes it. */
export function sesBounce(
  addresses: string[],
  bounceType: 'Permanent' | 'Transient' = 'Permanent',
): unknown {
  return {
    eventType: 'Bounce',
    bounce: {
      bounceType,
      bounceSubType: bounceType === 'Permanent' ? 'General' : 'MailboxFull',
      bouncedRecipients: addresses.map((emailAddress) => ({
        emailAddress,
        diagnosticCode: 'smtp; 550 5.1.1 user unknown',
      })),
      timestamp: '2026-11-18T12:00:00.000Z',
    },
    mail: { messageId: 'ses-1', destination: addresses },
  }
}

/** An SES complaint as an identity's notification topic delivers it. */
export function sesComplaint(addresses: string[]): unknown {
  return {
    notificationType: 'Complaint',
    complaint: {
      complainedRecipients: addresses.map((emailAddress) => ({ emailAddress })),
      complaintFeedbackType: 'abuse',
      timestamp: '2026-11-18T12:00:00.000Z',
    },
    mail: { messageId: 'ses-2', destination: addresses },
  }
}
