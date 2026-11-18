import { verify } from 'node:crypto'
import { env } from './env'

/** An Amazon SNS HTTP(S) message, as POSTed to a subscribed endpoint. */
export type SnsMessage = {
  Type: 'Notification' | 'SubscriptionConfirmation' | 'UnsubscribeConfirmation'
  MessageId: string
  TopicArn: string
  Message: string
  Timestamp: string
  SignatureVersion: string
  Signature: string
  SigningCertURL: string
  Subject?: string
  SubscribeURL?: string
  Token?: string
}

const SIGNED_FIELDS = {
  Notification: ['Message', 'MessageId', 'Subject', 'Timestamp', 'TopicArn', 'Type'],
  SubscriptionConfirmation: [
    'Message',
    'MessageId',
    'SubscribeURL',
    'Timestamp',
    'Token',
    'TopicArn',
    'Type',
  ],
} as const satisfies Record<string, (keyof SnsMessage)[]>

const ALGORITHMS: Record<string, string> = { '1': 'sha1', '2': 'sha256' }

// Certificates and SubscribeURLs are only ever fetched from SNS itself, and a certificate only
// from the path SNS publishes them at, so a forged message cannot send us fetching elsewhere.
const SNS_HOST = /^sns\.[a-z0-9-]+\.amazonaws\.com(\.cn)?$/
const CERTIFICATE_PATH = /^\/SimpleNotificationService-[0-9a-f]+\.pem$/

export function isSnsUrl(value: string | undefined, path?: RegExp): value is string {
  try {
    const url = new URL(value ?? '')
    return (
      url.protocol === 'https:' && SNS_HOST.test(url.hostname) && (!path || path.test(url.pathname))
    )
  } catch {
    return false
  }
}

/**
 * The bytes SNS signs: each signed field present, as its name and value on lines of their own,
 * in a fixed order. An unsubscribe confirmation is signed like a subscription confirmation.
 */
export function snsStringToSign(message: SnsMessage): string {
  const fields =
    message.Type === 'Notification'
      ? SIGNED_FIELDS.Notification
      : SIGNED_FIELDS.SubscriptionConfirmation
  return fields
    .filter((field) => message[field] !== undefined && message[field] !== null)
    .map((field) => `${field}\n${message[field]}\n`)
    .join('')
}

/** True when `value` has the fields every SNS message carries, all strings. */
export function isSnsMessage(value: unknown): value is SnsMessage {
  if (!value || typeof value !== 'object') return false
  const fields = ['Type', 'MessageId', 'TopicArn', 'Message', 'Timestamp'] as const
  const record = value as Record<string, unknown>
  return (
    fields.every((field) => typeof record[field] === 'string') &&
    ['Notification', 'SubscriptionConfirmation', 'UnsubscribeConfirmation'].includes(
      record.Type as string,
    )
  )
}

/**
 * The network side of SNS: fetching signing certificates and confirming subscriptions. The
 * route calls whichever gateway `snsGateway()` returns; tests swap in their own with
 * `setSnsGateway`.
 */
export abstract class SnsGateway {
  /** The PEM certificate (or public key) at `url`. Throws if it cannot be fetched. */
  abstract certificate(url: string): Promise<string>
  /** Visits a SubscriptionConfirmation's SubscribeURL, which confirms the subscription. */
  abstract confirm(subscribeUrl: string): Promise<void>
}

const MAX_CACHED_CERTIFICATES = 20

export class HttpSnsGateway extends SnsGateway {
  // SNS signs with a handful of long-lived certificates, so a small cache saves a fetch per message.
  private readonly certificates = new Map<string, string>()

  async certificate(url: string): Promise<string> {
    const cached = this.certificates.get(url)
    if (cached) return cached
    const res = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(10_000) })
    if (!res.ok) throw new Error(`SNS certificate fetch failed: ${res.status}`)
    const pem = await res.text()
    if (this.certificates.size >= MAX_CACHED_CERTIFICATES) this.certificates.clear()
    this.certificates.set(url, pem)
    return pem
  }

  async confirm(subscribeUrl: string): Promise<void> {
    const res = await fetch(subscribeUrl, {
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) throw new Error(`SNS subscription confirmation failed: ${res.status}`)
  }
}

let current: SnsGateway | undefined

export function snsGateway(): SnsGateway {
  return (current ??= new HttpSnsGateway())
}

/** Replaces the process-wide gateway and returns the previous one. */
export function setSnsGateway(gateway: SnsGateway | undefined): SnsGateway | undefined {
  const previous = current
  current = gateway
  return previous
}

export type SnsVerdict = { ok: true } | { ok: false; reason: string }

/**
 * Whether `message` really came from SNS on a topic this app subscribed to: the topic is on
 * SES_FEEDBACK_TOPIC_ARN, the certificate is served by SNS, and the signature over the signed
 * fields checks out against it. The topic is checked first, so a stranger's topic costs no fetch.
 */
export async function verifySnsMessage(message: SnsMessage): Promise<SnsVerdict> {
  if (!env.SES_FEEDBACK_TOPIC_ARN || message.TopicArn !== env.SES_FEEDBACK_TOPIC_ARN) {
    return { ok: false, reason: 'topic not allowed' }
  }
  const algorithm = ALGORITHMS[message.SignatureVersion]
  if (!algorithm) return { ok: false, reason: 'unknown signature version' }
  if (typeof message.Signature !== 'string' || !message.Signature) {
    return { ok: false, reason: 'unsigned' }
  }
  if (!isSnsUrl(message.SigningCertURL, CERTIFICATE_PATH)) {
    return { ok: false, reason: 'certificate not on an SNS host' }
  }
  let certificate: string
  try {
    certificate = await snsGateway().certificate(message.SigningCertURL)
  } catch {
    return { ok: false, reason: 'certificate unavailable' }
  }
  try {
    const signature = Buffer.from(message.Signature, 'base64')
    const valid = verify(algorithm, Buffer.from(snsStringToSign(message)), certificate, signature)
    return valid ? { ok: true } : { ok: false, reason: 'bad signature' }
  } catch {
    return { ok: false, reason: 'bad signature' }
  }
}
