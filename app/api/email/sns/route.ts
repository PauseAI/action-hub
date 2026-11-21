import { NextRequest, NextResponse } from 'next/server'
import { suppressAddresses } from '@/lib/email-suppression'
import { prisma } from '@/lib/prisma'
import { logger } from '@/lib/logger'
import { isSnsMessage, isSnsUrl, snsGateway, verifySnsMessage, type SnsMessage } from '@/lib/sns'

// SNS caps a message at 256 KB.
const MAX_BODY_BYTES = 262_144

type Recipient = { emailAddress?: unknown }

/** The fields read from an SES bounce or complaint, whether from a configuration set or an identity. */
type SesEvent = {
  eventType?: string
  notificationType?: string
  bounce?: {
    bounceType?: string
    bounceSubType?: string
    bouncedRecipients?: Recipient[]
  }
  complaint?: { complainedRecipients?: Recipient[]; complaintFeedbackType?: string }
}

function addresses(recipients: Recipient[] | undefined): string[] {
  return (recipients ?? []).flatMap((r) =>
    typeof r.emailAddress === 'string' ? [r.emailAddress] : [],
  )
}

async function suppress(
  recipients: Recipient[] | undefined,
  reason: 'bounce' | 'complaint',
  detail: string | null,
): Promise<void> {
  const list = addresses(recipients)
  await suppressAddresses(list, reason, detail)
  logger.info(`[EMAIL SNS] Suppressed ${list.length} address(es) for ${reason}`)
}

/**
 * Suppresses the addresses in an SES event. Only a permanent bounce suppresses: a transient one
 * (mailbox full, out of office) may deliver next time. Other event types are ignored.
 */
async function handleSesEvent(event: SesEvent): Promise<void> {
  const type = event.eventType ?? event.notificationType
  if (type === 'Bounce' && event.bounce?.bounceType === 'Permanent') {
    const { bounceType, bounceSubType, bouncedRecipients } = event.bounce
    // The diagnostic code is left out: it often quotes the address back.
    await suppress(bouncedRecipients, 'bounce', `${bounceType}/${bounceSubType}`)
  } else if (type === 'Complaint' && event.complaint?.complaintFeedbackType !== 'not-spam') {
    // A "not-spam" report is the recipient rescuing our mail from their spam folder.
    const { complainedRecipients, complaintFeedbackType } = event.complaint ?? {}
    await suppress(complainedRecipients, 'complaint', complaintFeedbackType ?? null)
  }
}

/** The body as text, or null once it passes `limit` bytes, however the request is framed. */
async function readBody(request: NextRequest, limit: number): Promise<string | null> {
  if (!request.body) return ''
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > limit) {
      await reader.cancel()
      return null
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

const status = (code: number) => new NextResponse(null, { status: code })

/**
 * Receives SES bounce and complaint notifications from Amazon SNS and stops mail to those
 * addresses. Anything not signed by SNS for a topic on SES_FEEDBACK_TOPIC_ARN is refused.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const text = await readBody(request, MAX_BODY_BYTES)
  if (text === null) return status(413)
  const body = parseJson(text)
  if (!isSnsMessage(body)) return status(400)
  const message: SnsMessage = body

  const verdict = await verifySnsMessage(message)
  if (!verdict.ok) {
    logger.warn({ topic: message.TopicArn, reason: verdict.reason }, '[EMAIL SNS] Refused message')
    // SNS retries a 5xx but gives up on a 4xx, so a certificate that could not be fetched this
    // time must not lose a real bounce for good.
    return status(verdict.retry ? 503 : 403)
  }

  if (message.Type === 'SubscriptionConfirmation') {
    if (!isSnsUrl(message.SubscribeURL)) return status(403)
    await snsGateway().confirm(message.SubscribeURL)
    logger.info({ topic: message.TopicArn }, '[EMAIL SNS] Confirmed subscription')
    return status(200)
  }
  if (message.Type === 'UnsubscribeConfirmation') {
    logger.warn({ topic: message.TopicArn }, '[EMAIL SNS] Unsubscribed from topic')
    return status(200)
  }

  const event = parseJson(message.Message)
  if (!event || typeof event !== 'object') return status(400)
  // SNS may deliver a message more than once, and a copy of a signed message could be posted
  // again within the hour its timestamp is accepted: each MessageId is handled once.
  const seen = await prisma.snsMessage.findUnique({ where: { messageId: message.MessageId } })
  if (seen) return status(200)
  await handleSesEvent(event as SesEvent)
  await prisma.snsMessage.createMany({
    data: [{ messageId: message.MessageId }],
    skipDuplicates: true,
  })
  return status(200)
}
