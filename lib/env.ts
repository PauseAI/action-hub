type EnvError = { var: string; reason: string }

const flag = (value: string | undefined): boolean =>
  ['1', 'true', 'yes'].includes((value ?? '').toLowerCase())

const DEFAULT_EMAIL_HOURLY_CAP = 500
const DEFAULT_EMAIL_ESSENTIAL_HOURLY_CAP = 200

const wholeNumber = (value: string | undefined, fallback: number): number =>
  /^\d+$/.test(value ?? '') ? Number(value) : fallback

/**
 * Typed view of the process environment. Each property reads `process.env` when accessed,
 * so a value changed after start-up (in tests, or by a script setting up its own) is seen
 * by the next call rather than frozen at import.
 */
export const env = {
  get NODE_ENV(): string {
    return process.env.NODE_ENV ?? 'development'
  },
  get APP_URL(): string {
    return process.env.APP_URL ?? ''
  },
  get RESEND_API_KEY(): string | undefined {
    return process.env.RESEND_API_KEY
  },
  get FROM_EMAIL(): string {
    return process.env.FROM_EMAIL ?? 'Action Hub <noreply@pauseai.uk>'
  },
  get REPLY_TO_EMAIL(): string | undefined {
    return process.env.REPLY_TO_EMAIL
  },
  /** `resend` or `ses`; validateEnv refuses anything else in production. */
  get EMAIL_PROVIDER(): string {
    return (process.env.EMAIL_PROVIDER || 'resend').trim().toLowerCase()
  },
  /** Most non-essential emails handed to the provider in one clock hour, across every process. */
  get EMAIL_HOURLY_CAP(): number {
    return wholeNumber(process.env.EMAIL_HOURLY_CAP, DEFAULT_EMAIL_HOURLY_CAP)
  },
  /** Most essential emails (password resets, confirmations) handed to the provider in an hour. */
  get EMAIL_ESSENTIAL_HOURLY_CAP(): number {
    return wholeNumber(process.env.EMAIL_ESSENTIAL_HOURLY_CAP, DEFAULT_EMAIL_ESSENTIAL_HOURLY_CAP)
  },
  /** Keys the hashes that suppressed addresses are stored under. */
  get EMAIL_HASH_SECRET(): string | undefined {
    return process.env.EMAIL_HASH_SECRET || undefined
  },
  /** The AWS SDK reads the same variable, with AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY. */
  get AWS_REGION(): string | undefined {
    return process.env.AWS_REGION || undefined
  },
  /** Applied to every SES send, so SES publishes its bounce and complaint events. */
  get SES_CONFIGURATION_SET(): string | undefined {
    return process.env.SES_CONFIGURATION_SET || undefined
  },
  /** The SNS topic whose bounce and complaint notifications /api/email/sns accepts. */
  get SES_FEEDBACK_TOPIC_ARN(): string | undefined {
    return process.env.SES_FEEDBACK_TOPIC_ARN?.trim() || undefined
  },
  /** Defaults on outside production, so a fresh dev checkout never tries to send email. */
  get STUB_EMAIL(): boolean {
    const fallback = process.env.NODE_ENV === 'production' ? '' : 'true'
    return flag(process.env.STUB_EMAIL || fallback)
  },
  get CRON_SECRET(): string | undefined {
    return process.env.CRON_SECRET
  },
  get ADMIN_EMAILS(): string {
    return process.env.ADMIN_EMAILS ?? ''
  },
  get DISABLE_RATE_LIMIT(): boolean {
    return flag(process.env.DISABLE_RATE_LIMIT)
  },
  get GOOGLE_CLIENT_ID(): string | undefined {
    return process.env.GOOGLE_CLIENT_ID
  },
  get STUB_GOOGLE(): boolean {
    return flag(process.env.STUB_GOOGLE)
  },
  get RAILWAY_GIT_COMMIT_SHA(): string | undefined {
    return process.env.RAILWAY_GIT_COMMIT_SHA
  },
  get RAILWAY_ENVIRONMENT_NAME(): string | undefined {
    return process.env.RAILWAY_ENVIRONMENT_NAME
  },
}

export function validateEnv(): void {
  if (process.env.NODE_ENV !== 'production') return
  // Railway PR deployments run as NODE_ENV=production but aren't the live environment
  if (process.env.RAILWAY_ENVIRONMENT_NAME && process.env.RAILWAY_ENVIRONMENT_NAME !== 'production')
    return
  // The e2e harness serves a production build locally with the stub flags on (see
  // e2e/global-setup.ts); it is not a deployment and must not be held to these rules.
  if (process.env.E2E === '1') return

  const errors: EnvError[] = []

  if (!env.APP_URL) {
    errors.push({ var: 'APP_URL', reason: 'required for correct links in emails' })
  }

  if (!env.CRON_SECRET) {
    errors.push({ var: 'CRON_SECRET', reason: 'required to authenticate cron endpoints' })
  }

  if (env.EMAIL_PROVIDER === 'ses') {
    const reason = 'required to send email through SES'
    const required = [
      'AWS_REGION',
      'AWS_ACCESS_KEY_ID',
      'AWS_SECRET_ACCESS_KEY',
      'SES_CONFIGURATION_SET',
      'EMAIL_HASH_SECRET',
      // The default sender is not on the domain SES verified, so every send would be refused.
      'FROM_EMAIL',
    ] as const
    for (const name of required) {
      if (!process.env[name]) errors.push({ var: name, reason })
    }
    if (!env.SES_FEEDBACK_TOPIC_ARN) {
      errors.push({
        var: 'SES_FEEDBACK_TOPIC_ARN',
        reason: 'required to stop mailing bounced addresses',
      })
    }
  } else if (env.EMAIL_PROVIDER !== 'resend') {
    errors.push({ var: 'EMAIL_PROVIDER', reason: 'must be resend or ses' })
  } else if (!env.RESEND_API_KEY) {
    errors.push({ var: 'RESEND_API_KEY', reason: 'required to send emails' })
  }

  // Development shortcuts that are unsafe in the live environment: STUB_GOOGLE accepts a
  // sign-in for any email with no Google credential, STUB_EMAIL returns password-reset and
  // invite tokens in API responses instead of mailing them, and DISABLE_RATE_LIMIT turns
  // off every limiter. Refuse to boot rather than run with any of them on.
  const unsafeStubs: Array<[string, boolean]> = [
    ['STUB_GOOGLE', env.STUB_GOOGLE],
    ['STUB_EMAIL', env.STUB_EMAIL],
    ['DISABLE_RATE_LIMIT', env.DISABLE_RATE_LIMIT],
  ]
  for (const [name, enabled] of unsafeStubs) {
    if (enabled) {
      errors.push({ var: name, reason: 'development-only flag, must be off in production' })
    }
  }

  if (errors.length === 0) return

  const lines = errors.map((e) => `  - ${e.var}: ${e.reason}`).join('\n')
  throw new Error(`Missing required environment variables:\n${lines}`)
}
