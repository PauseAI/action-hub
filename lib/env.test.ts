import { describe, it, expect, vi, afterEach } from 'vitest'
import { env, validateEnv } from './env'

afterEach(() => {
  vi.unstubAllEnvs()
})

/** Sets the given variables (deleting those given as undefined) and returns the live env. */
function loadEnv(vars: Record<string, string | undefined>) {
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) vi.stubEnv(k, undefined)
    else vi.stubEnv(k, v)
  }
  return { env, validateEnv }
}

const PROD = { NODE_ENV: 'production', RAILWAY_ENVIRONMENT_NAME: 'production', E2E: undefined }
const SAFE_PROD = {
  ...PROD,
  APP_URL: 'https://x',
  CRON_SECRET: 's',
  RESEND_API_KEY: 'k',
  STUB_GOOGLE: '',
  STUB_EMAIL: '',
  DISABLE_RATE_LIMIT: '',
}

describe('env', () => {
  it('parses boolean-ish flags and defaults', async () => {
    const { env } = loadEnv({
      NODE_ENV: 'development',
      STUB_EMAIL: undefined,
      DISABLE_RATE_LIMIT: 'YES',
      STUB_GOOGLE: '1',
      FROM_EMAIL: undefined,
      REPLY_TO_EMAIL: 'reply@x',
      ADMIN_EMAILS: undefined,
      APP_URL: undefined,
    })
    expect(env.STUB_EMAIL).toBe(true) // default outside production
    expect(env.DISABLE_RATE_LIMIT).toBe(true)
    expect(env.STUB_GOOGLE).toBe(true)
    expect(env.FROM_EMAIL).toContain('noreply')
    expect(env.REPLY_TO_EMAIL).toBe('reply@x')
    expect(env.ADMIN_EMAILS).toBe('')
    expect(env.APP_URL).toBe('')
    expect(env.NODE_ENV).toBe('development')
  })

  it('defaults NODE_ENV to development', async () => {
    const { env } = loadEnv({ NODE_ENV: undefined, STUB_EMAIL: undefined })
    expect(env.NODE_ENV).toBe('development')
  })

  it('defaults STUB_EMAIL off in production', async () => {
    const { env } = loadEnv({ NODE_ENV: 'production', STUB_EMAIL: undefined })
    expect(env.STUB_EMAIL).toBe(false)
  })
})

describe('validateEnv', () => {
  it('does nothing outside a live production deployment', async () => {
    loadEnv({ NODE_ENV: 'development' }).validateEnv()
    loadEnv({ NODE_ENV: 'production', RAILWAY_ENVIRONMENT_NAME: 'pr-12' }).validateEnv()
    loadEnv({ ...PROD, E2E: '1' }).validateEnv()
  })

  it('passes a fully configured production environment', async () => {
    ;(
      await loadEnv({
        ...SAFE_PROD,
        B2_KEY_ID: undefined,
        B2_APP_KEY: undefined,
        B2_BUCKET_NAME: undefined,
      })
    ).validateEnv()
  })

  it('lists every missing variable and unsafe stub', async () => {
    const { validateEnv } = await loadEnv({
      ...PROD,
      APP_URL: '',
      CRON_SECRET: '',
      RESEND_API_KEY: '',
      STUB_GOOGLE: 'true',
      STUB_EMAIL: 'true',
      DISABLE_RATE_LIMIT: 'true',
      B2_KEY_ID: 'id',
      B2_APP_KEY: '',
      B2_BUCKET_NAME: '',
    })
    expect(() => validateEnv()).toThrow(
      /APP_URL[\s\S]*CRON_SECRET[\s\S]*RESEND_API_KEY[\s\S]*STUB_GOOGLE[\s\S]*STUB_EMAIL[\s\S]*DISABLE_RATE_LIMIT[\s\S]*B2_APP_KEY[\s\S]*B2_BUCKET_NAME/,
    )
  })
})

describe('email provider settings', () => {
  it('defaults to Resend with a 500-an-hour cap, and reads SES settings', () => {
    const { env } = loadEnv({
      EMAIL_PROVIDER: undefined,
      EMAIL_HOURLY_CAP: undefined,
      EMAIL_ESSENTIAL_HOURLY_CAP: undefined,
      SES_FEEDBACK_TOPIC_ARN: undefined,
      SES_CONFIGURATION_SET: undefined,
      AWS_REGION: undefined,
    })
    expect(env.EMAIL_PROVIDER).toBe('resend')
    expect(env.EMAIL_HOURLY_CAP).toBe(500)
    expect(env.EMAIL_ESSENTIAL_HOURLY_CAP).toBe(200)
    expect(env.SES_FEEDBACK_TOPIC_ARN).toBeUndefined()
    expect(env.SES_CONFIGURATION_SET).toBeUndefined()
    expect(env.AWS_REGION).toBeUndefined()

    loadEnv({
      EMAIL_PROVIDER: ' SES ',
      EMAIL_HOURLY_CAP: '20',
      SES_FEEDBACK_TOPIC_ARN: ' arn:a ',
      SES_CONFIGURATION_SET: 'action-hub',
      AWS_REGION: 'eu-west-1',
    })
    expect(env.EMAIL_PROVIDER).toBe('ses')
    expect(env.EMAIL_HOURLY_CAP).toBe(20)
    expect(env.SES_FEEDBACK_TOPIC_ARN).toBe('arn:a')
    expect(env.SES_CONFIGURATION_SET).toBe('action-hub')
    expect(env.AWS_REGION).toBe('eu-west-1')
  })

  it('treats a cap that is not a whole number of emails as the default', () => {
    for (const value of ['lots', '-1', '2.5', '']) {
      expect(loadEnv({ EMAIL_HOURLY_CAP: value }).env.EMAIL_HOURLY_CAP, value).toBe(500)
    }
    expect(loadEnv({ EMAIL_HOURLY_CAP: '0' }).env.EMAIL_HOURLY_CAP).toBe(0)
  })

  it('requires the AWS settings, not a Resend key, when sending through SES', () => {
    const ses = {
      ...SAFE_PROD,
      EMAIL_PROVIDER: 'ses',
      RESEND_API_KEY: '',
      AWS_REGION: 'eu-west-1',
      AWS_ACCESS_KEY_ID: 'id',
      AWS_SECRET_ACCESS_KEY: 'secret',
      SES_CONFIGURATION_SET: 'action-hub',
      EMAIL_HASH_SECRET: 'secret',
      FROM_EMAIL: 'Action Hub <noreply@action.pauseai.info>',
      SES_FEEDBACK_TOPIC_ARN: 'arn:aws:sns:eu-west-1:1:ses-action-hub-feedback',
    }
    loadEnv(ses).validateEnv()
    const { validateEnv } = loadEnv({
      ...ses,
      AWS_REGION: '',
      AWS_ACCESS_KEY_ID: '',
      AWS_SECRET_ACCESS_KEY: '',
      SES_CONFIGURATION_SET: '',
      EMAIL_HASH_SECRET: '',
      FROM_EMAIL: '',
      SES_FEEDBACK_TOPIC_ARN: '',
    })
    expect(() => validateEnv()).toThrow(
      /AWS_REGION[\s\S]*AWS_ACCESS_KEY_ID[\s\S]*AWS_SECRET_ACCESS_KEY[\s\S]*SES_CONFIGURATION_SET[\s\S]*EMAIL_HASH_SECRET[\s\S]*FROM_EMAIL[\s\S]*SES_FEEDBACK_TOPIC_ARN/,
    )
    expect(() => validateEnv()).not.toThrow(/RESEND_API_KEY/)
  })

  it('refuses a provider it does not know', () => {
    const { validateEnv } = loadEnv({ ...SAFE_PROD, EMAIL_PROVIDER: 'postmark' })
    expect(() => validateEnv()).toThrow(/EMAIL_PROVIDER: must be resend or ses/)
  })
})
