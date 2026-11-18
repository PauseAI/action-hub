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

// Version 1 signs with SHA-1; the topic is set to version 2 (SHA-256), and nothing else is
// accepted.
const SIGNATURE_VERSION = '2'
/** How old a message may be: SNS's own retries to an endpoint finish well within it. */
export const MAX_MESSAGE_AGE_MS = 60 * 60 * 1000
const CLOCK_SKEW_MS = 5 * 60 * 1000

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
const MAX_FAILED_FETCHES = 5
const FAILED_FETCH_WINDOW_MS = 10 * 60 * 1000

export class HttpSnsGateway extends SnsGateway {
  // SNS signs with a handful of long-lived certificates, so a small cache saves a fetch per message.
  private readonly certificates = new Map<string, string>()
  // A forged message can name any certificate path on an SNS host, so fetches that fail are
  // rationed: past a few in a window, nothing uncached is fetched until the window passes.
  private failedFetches: number[] = []

  async certificate(url: string): Promise<string> {
    const cached = this.certificates.get(url)
    if (cached) return cached
    const now = Date.now()
    this.failedFetches = this.failedFetches.filter((t) => t > now - FAILED_FETCH_WINDOW_MS)
    if (this.failedFetches.length >= MAX_FAILED_FETCHES) {
      throw new Error('too many failed SNS certificate fetches')
    }
    const res = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(10_000) })
    if (!res.ok) {
      this.failedFetches.push(now)
      throw new Error(`SNS certificate fetch failed: ${res.status}`)
    }
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
 * Whether `message` really came from SNS on a topic this app subscribed to, recently: the topic
 * is SES_FEEDBACK_TOPIC_ARN, it was signed with version 2 within the last hour, the certificate
 * is served by SNS, and the signature over the signed fields checks out against it. Everything
 * but the signature is checked first, so a forged message costs no fetch.
 */
export async function verifySnsMessage(message: SnsMessage): Promise<SnsVerdict> {
  if (!env.SES_FEEDBACK_TOPIC_ARN || message.TopicArn !== env.SES_FEEDBACK_TOPIC_ARN) {
    return { ok: false, reason: 'topic not allowed' }
  }
  if (message.SignatureVersion !== SIGNATURE_VERSION) {
    return { ok: false, reason: 'signature version not 2' }
  }
  const age = Date.now() - Date.parse(message.Timestamp)
  if (!(age <= MAX_MESSAGE_AGE_MS && age >= -CLOCK_SKEW_MS)) {
    return { ok: false, reason: 'stale or future timestamp' }
  }
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
    const valid = verify('sha256', Buffer.from(snsStringToSign(message)), certificate, signature)
    return valid ? { ok: true } : { ok: false, reason: 'bad signature' }
  } catch {
    return { ok: false, reason: 'bad signature' }
  }
}
