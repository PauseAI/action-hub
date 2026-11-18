import { randomUUID } from 'node:crypto'
import { Resend } from 'resend'
import { SendEmailCommand, SESv2Client } from '@aws-sdk/client-sesv2'
import type { PrismaClient } from '@/generated/prisma/client'
import { env } from './env'
import { logger } from './logger'

export type OutgoingEmail = {
  to: string
  subject: string
  html: string
  replyTo?: string
  /** One person's own request, such as a password reset: kept out of the bulk cap. */
  essential?: boolean
}

/**
 * The last hop of an outgoing email. Every template in `lib/email.tsx` builds an OutgoingEmail
 * and hands it to whichever transport `emailTransport()` returns (with SES, inside
 * GuardedTransport); tests swap in their own with `setEmailTransport`.
 */
export abstract class EmailTransport {
  /** Resolves true once the email has been accepted; false when it could not be sent. */
  abstract send(email: OutgoingEmail): Promise<boolean>
  /** False when sends are dropped, so callers can skip email-only features. */
  configured(): boolean {
    return true
  }
}

type EmailEnv = Pick<
  typeof env,
  | 'STUB_EMAIL'
  | 'RESEND_API_KEY'
  | 'FROM_EMAIL'
  | 'REPLY_TO_EMAIL'
  | 'EMAIL_PROVIDER'
  | 'AWS_REGION'
  | 'SES_CONFIGURATION_SET'
>

/** The part of the Resend SDK this transport uses, so tests can pass a fake client. */
export type ResendClient = Pick<Resend, 'emails'>

export class ResendTransport extends EmailTransport {
  constructor(
    private readonly config: EmailEnv,
    private readonly resend: ResendClient = new Resend(config.RESEND_API_KEY),
  ) {
    super()
  }

  async send({ to, subject, html, replyTo }: OutgoingEmail): Promise<boolean> {
    try {
      const payload: Parameters<Resend['emails']['send']>[0] = {
        from: this.config.FROM_EMAIL,
        to: [to],
        subject,
        html,
      }
      const effectiveReplyTo = replyTo || this.config.REPLY_TO_EMAIL
      if (effectiveReplyTo) payload.replyTo = effectiveReplyTo
      const { error } = await this.resend.emails.send(payload)
      if (error) {
        logger.error(`[EMAIL ERROR] ${error.message}`)
        return false
      }
      return true
    } catch (err) {
      logger.error(err, '[EMAIL ERROR]')
      return false
    }
  }
}

/** The part of the SESv2 client this transport uses, so tests can pass a fake client. */
export type SesClient = Pick<SESv2Client, 'send'>

/** Amazon SES. Credentials come from the AWS SDK's own chain (AWS_ACCESS_KEY_ID and friends). */
export class SesTransport extends EmailTransport {
  constructor(
    private readonly config: EmailEnv,
    private readonly ses: SesClient = new SESv2Client({ region: config.AWS_REGION }),
  ) {
    super()
  }

  async send({ to, subject, html, replyTo }: OutgoingEmail): Promise<boolean> {
    const effectiveReplyTo = replyTo || this.config.REPLY_TO_EMAIL
    try {
      await this.ses.send(
        new SendEmailCommand({
          FromEmailAddress: this.config.FROM_EMAIL,
          Destination: { ToAddresses: [to] },
          ...(effectiveReplyTo && { ReplyToAddresses: [effectiveReplyTo] }),
          ConfigurationSetName: this.config.SES_CONFIGURATION_SET,
          Content: {
            Simple: {
              Subject: { Data: subject, Charset: 'UTF-8' },
              Body: { Html: { Data: html, Charset: 'UTF-8' } },
            },
          },
        }),
      )
      return true
    } catch (err) {
      logger.error(err, '[EMAIL ERROR] SES')
      return false
    }
  }
}

/** Development transport: writes each email to disk and logs the path so it can be opened. */
export class FileStubTransport extends EmailTransport {
  static readonly DIR = '/tmp/action-hub-emails'

  async send({ to, subject, html }: OutgoingEmail): Promise<boolean> {
    const fs = await import('fs/promises')
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
    const slug = subject
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '')
      .slice(0, 60)
    // A fan-out sends several same-subject emails within one millisecond, so the timestamp
    // alone would name the same file for each of them.
    const file = `${FileStubTransport.DIR}/${timestamp}_${slug}_${randomUUID().slice(0, 8)}.html`
    await fs.mkdir(FileStubTransport.DIR, { recursive: true })
    await fs.writeFile(file, html)
    logger.info(`[EMAIL STUB] To: ${to} | Subject: ${subject}\n[EMAIL STUB] Preview: ${file}`)
    return true
  }
}

/** Used when neither a stub, SES nor a Resend key is configured: logs the send and drops it. */
export class UnconfiguredTransport extends EmailTransport {
  async send({ to, subject }: OutgoingEmail): Promise<boolean> {
    logger.info(`[EMAIL NOT CONFIGURED] Would send to ${to}: ${subject}`)
    return false
  }

  configured(): boolean {
    return false
  }
}

const HOUR_MS = 60 * 60 * 1000
/** Essential emails one address may be sent in an hour, so nobody can flood a stranger with resets. */
export const ESSENTIAL_PER_RECIPIENT_HOURLY = 5

/**
 * Wraps SES so that nothing reaches it for a suppressed address (lib/email-suppression.ts),
 * and a bug cannot mail everyone: at most EMAIL_HOURLY_CAP emails an hour go out in all. Essential
 * mail (a password reset, a confirmation link) is kept apart, so a bulk run cannot lock anyone
 * out and anyone requesting resets cannot use up the bulk allowance: it has its own cap,
 * EMAIL_ESSENTIAL_HOURLY_CAP, and a limit per recipient. Counts live in the database, so every
 * process shares them. Fails closed: when the database cannot answer, nothing is sent.
 */
export class GuardedTransport extends EmailTransport {
  constructor(readonly inner: EmailTransport) {
    super()
  }

  async send(email: OutgoingEmail): Promise<boolean> {
    let db: PrismaClient
    let hour: Date
    const claimed: string[] = []
    try {
      // Loaded here, not at the top: the test harness imports this module before it has set
      // the database URL that `lib/prisma` reads when it is first imported.
      const [{ prisma }, suppression] = await Promise.all([
        import('./prisma'),
        import('./email-suppression'),
      ])
      db = prisma
      const reason = await suppression.suppressionOf(email.to)
      if (reason) {
        logger.info(`[EMAIL SUPPRESSED] Not sending "${email.subject}": ${reason}`)
        return false
      }
      hour = new Date(Math.floor(Date.now() / HOUR_MS) * HOUR_MS)
      // Each bucket with its cap, and the setting to name in the log once that cap is reached.
      const buckets: [string, number, string | null][] = email.essential
        ? [
            [`to:${suppression.suppressionKey(email.to)}`, ESSENTIAL_PER_RECIPIENT_HOURLY, null],
            ['essential', env.EMAIL_ESSENTIAL_HOURLY_CAP, 'EMAIL_ESSENTIAL_HOURLY_CAP'],
          ]
        : [['bulk', env.EMAIL_HOURLY_CAP, 'EMAIL_HOURLY_CAP']]
      for (const [bucket, cap, setting] of buckets) {
        if (!(await this.claim(db, hour, bucket, cap, setting))) {
          await this.release(db, hour, claimed)
          return false
        }
        claimed.push(bucket)
      }
    } catch (err) {
      logger.error(err, '[EMAIL ERROR] Suppression or cap check failed; not sending')
      return false
    }
    const sent = await this.inner.send(email).catch((err: unknown) => {
      logger.error(err, '[EMAIL ERROR]')
      return false
    })
    // A send that went nowhere gives its slots back, so an outage does not use up the hour.
    if (!sent) {
      await this.release(db, hour, claimed).catch((err: unknown) =>
        logger.error(err, '[EMAIL ERROR] Could not return a send slot'),
      )
    }
    return sent
  }

  configured(): boolean {
    return this.inner.configured()
  }

  /** Takes one send from `bucket`'s allowance this hour; false once `cap` are taken. */
  private async claim(
    db: PrismaClient,
    hour: Date,
    bucket: string,
    cap: number,
    setting: string | null,
  ): Promise<boolean> {
    const { count } = await db.emailSendCount.upsert({
      where: { hour_bucket: { hour, bucket } },
      create: { hour, bucket, count: 1 },
      update: { count: { increment: 1 } },
    })
    if (count <= cap) return true
    // A refused claim stays counted, so the cap is announced once, not once per refused email.
    if (count === cap + 1 && setting) {
      logger.error(
        { hour, cap },
        `[EMAIL CAP] ${setting} of ${cap} reached; no more ${bucket} email until the next hour`,
      )
    }
    return false
  }

  private async release(db: PrismaClient, hour: Date, buckets: string[]): Promise<void> {
    if (buckets.length === 0) return
    await db.emailSendCount.updateMany({
      where: { hour, bucket: { in: buckets }, count: { gt: 0 } },
      data: { count: { decrement: 1 } },
    })
  }
}

/** SES comes wrapped in GuardedTransport; Resend, the stub and the unconfigured drop do not. */
export function createEmailTransport(config: EmailEnv = env): EmailTransport {
  if (config.STUB_EMAIL) return new FileStubTransport()
  if (config.EMAIL_PROVIDER === 'ses') return new GuardedTransport(new SesTransport(config))
  if (config.RESEND_API_KEY) return new ResendTransport(config)
  return new UnconfiguredTransport()
}

let current: EmailTransport | undefined

/** The process-wide transport, built from the environment on first use. */
export function emailTransport(): EmailTransport {
  return (current ??= createEmailTransport())
}

/**
 * Replaces the process-wide transport; `undefined` makes the next call rebuild it from
 * the environment. Returns the previous transport so a caller can restore it.
 */
export function setEmailTransport(
  transport: EmailTransport | undefined,
): EmailTransport | undefined {
  const previous = current
  current = transport
  return previous
}
