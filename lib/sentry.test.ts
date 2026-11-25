import type { Breadcrumb, ErrorEvent } from '@sentry/nextjs'
import { describe, expect, it } from 'vitest'
import {
  browserSentryEnv,
  isSensitiveKey,
  scrubBreadcrumb,
  scrubEvent,
  scrubText,
  scrubUrl,
  scrubValue,
  sentryOptions,
  sentryOrigin,
  serverSentrySettings,
} from './sentry'

const TOKEN = 'k3Jd9_Xq2LmN8vB4rT6yU1wE5oP0aSdF7gH-zXcVbNm'
const event = (e: Partial<ErrorEvent>): ErrorEvent => ({ type: undefined, ...e })

describe('scrubText', () => {
  it('replaces email addresses', () => {
    expect(scrubText('Could not send to ada.lovelace+news@example.co.uk: bounced')).toBe(
      'Could not send to [email]: bounced',
    )
  })

  it('replaces IPv4 and IPv6 addresses but not versions or times', () => {
    expect(scrubText('connect ECONNREFUSED 203.0.113.9:5432 from ::ffff:198.51.100.7')).toBe(
      'connect ECONNREFUSED [ip]:5432 from [ip]',
    )
    expect(scrubText('client 2001:db8:85a3:0:0:8a2e:370:7334 and 2001:db8::1 and ::1')).toBe(
      'client [ip] and [ip] and [ip]',
    )
    expect(scrubText('node v24.22.1 at 12:30:45')).toBe('node v24.22.1 at 12:30:45')
  })

  it('replaces bearer tokens', () => {
    expect(scrubText(`sent Bearer ${TOKEN} upstream`)).toBe('sent Bearer [Filtered] upstream')
    expect(scrubText(`Authorization: Bearer ${TOKEN}`)).not.toContain(TOKEN)
  })

  it('replaces query strings', () => {
    expect(scrubText('GET /reset-password?token=abc&x=1 failed')).toBe(
      'GET /reset-password?[Filtered] failed',
    )
  })

  it('replaces quoted values of name, email and token pairs in dumps and JSON', () => {
    expect(scrubText(`{ data: { name: "Ada Lovelace", firstName: 'Ada', bio: "Hi" } }`)).toBe(
      `{ data: { name: "[Filtered]", firstName: '[Filtered]', bio: "[Filtered]" } }`,
    )
    expect(scrubText('{"displayName":"Grace \\"G\\" Hopper","id":3}')).toBe(
      '{"displayName":"[Filtered]","id":3}',
    )
  })

  it('cuts the arguments out of a Prisma error, keeping its call and reason', () => {
    const prisma = [
      'Invalid `prisma.volunteer.update()` invocation in',
      '/app/server/routers/profile.ts:42:3',
      '',
      '  41 const v = await prisma.volunteer.update({',
      '→ 42   data: { signalNumber: "+44 7700 900123", passwordHash: "$2b$12$abc" }',
      '  43 })',
      '',
      'Unknown argument `signalNumbr`. Did you mean `signalNumber`?',
    ].join('\n')
    expect(scrubText(prisma)).toBe(
      'Invalid `prisma.volunteer.update()` invocation: [arguments filtered]\n\n' +
        'Unknown argument `signalNumbr`. Did you mean `signalNumber`?',
    )
    expect(scrubText('Invalid `prisma.x.create()` invocation: { name: "Ada" }')).toBe(
      'Invalid `prisma.x.create()` invocation: [arguments filtered]',
    )
  })

  it("replaces values under any key naming personal data, and Postgres's key detail", () => {
    expect(
      scrubText(
        '{ signalNumber: "+447700900123", whatsappNumber: \'07700\', discordHandle: "ada#1", contactNotes: "x", location: "Leeds" }',
      ),
    ).toBe(
      '{ signalNumber: "[Filtered]", whatsappNumber: \'[Filtered]\', discordHandle: "[Filtered]", contactNotes: "[Filtered]", location: "[Filtered]" }',
    )
    expect(scrubText('Key (name)=(Ada (Al) Lovelace) already exists.')).toBe(
      'Key (name)=([Filtered]) already exists.',
    )
    expect(scrubText('Key (email, chapter)=(ada@x.io, 3)')).toBe(
      'Key (email, chapter)=([Filtered])',
    )
    expect(scrubText('call me on +44 7700 900123 today')).toBe('call me on [phone] today')
  })

  it('replaces long opaque tokens but keeps words and ids', () => {
    expect(scrubText(`session ${TOKEN} for volunteer 42`)).toBe(
      'session [Filtered] for volunteer 42',
    )
    expect(scrubText('PrismaClientKnownRequestErrorWithSuffix')).toBe(
      'PrismaClientKnownRequestErrorWithSuffix',
    )
  })
})

describe('scrubText, unquoted and national-format values', () => {
  it('replaces unquoted values after a sensitive key, up to the next delimiter or key', () => {
    expect(scrubText('signalNumber=07700 900123, retry')).toBe('signalNumber=[Filtered], retry')
    expect(scrubText('phone: 07700900123 failed')).toBe('phone: [Filtered]')
    expect(scrubText('name=Ada+Lovelace&whatsapp=07700900123&page=2')).toBe(
      'name=[Filtered]&whatsapp=[Filtered]&page=2',
    )
    expect(scrubText("where: { email: 'a', id: 3 }")).toBe("where: { email: '[Filtered]', id: 3 }")
  })

  it('replaces national-format phone numbers, not other numbers', () => {
    expect(scrubText('call 07700 900123 or 020-7946-0958')).toBe('call [phone] or [phone]')
    expect(scrubText('volunteer 1234567 at 1795629730875 ms, v24.22.1')).toBe(
      'volunteer 1234567 at 1795629730875 ms, v24.22.1',
    )
  })

  it('replaces any run of 40 or more token characters, digits or not', () => {
    const noDigits = 'kJdXqLmNvBrTyUwEoPaSdFgHzXcVbNmQwErTyUiOpAs'
    expect(scrubText(`invite ${noDigits} expired`)).toBe('invite [Filtered] expired')
  })
})

describe('isSensitiveKey', () => {
  it('matches personal words as whole words of a key, in any case style', () => {
    for (const key of [
      'name',
      'firstName',
      'user_name',
      'username',
      'aria-label',
      'signalNumber',
      'passwordHash',
      'contactNotes',
      'e-mail',
      'X-Api-Key',
      'http.query',
      'ip_address',
    ]) {
      expect(isSensitiveKey(key), key).toBe(true)
    }
  })

  it('leaves words that only contain one alone', () => {
    for (const key of ['filename', 'hostname', 'pathname', 'statusCode', 'metadata', 'route']) {
      expect(isSensitiveKey(key), key).toBe(false)
    }
  })
})

describe('scrubUrl', () => {
  it('drops the query string and fragment', () => {
    expect(scrubUrl('https://action.pauseai.info/verify-email?token=abc#top')).toBe(
      'https://action.pauseai.info/verify-email',
    )
    expect(scrubUrl('/projects/3#tasks')).toBe('/projects/3')
  })
})

describe('scrubValue', () => {
  it('replaces sensitive keys at any depth and scrubs every string', () => {
    expect(
      scrubValue({
        id: 7,
        email: 'a@b.co',
        profile: { lastName: 'Turing', team: 'mail c@d.org', tags: ['x@y.io'] },
        password_hash: 'x',
        sessionToken: TOKEN,
        signalNumber: '+447700900123',
        applicationAdminNotes: 'kind',
      }),
    ).toEqual({
      id: 7,
      email: '[Filtered]',
      profile: { lastName: '[Filtered]', team: 'mail [email]', tags: ['[email]'] },
      password_hash: '[Filtered]',
      sessionToken: '[Filtered]',
      signalNumber: '[Filtered]',
      applicationAdminNotes: '[Filtered]',
    })
  })

  it('keeps keys when told to, scrubbing only strings', () => {
    expect(scrubValue({ name: 'node', version: 'a@b.co' }, false)).toEqual({
      name: 'node',
      version: '[email]',
    })
  })

  it('cuts cycles and deep nesting', () => {
    const cyclic: Record<string, unknown> = { a: 1 }
    cyclic.self = cyclic
    expect(scrubValue(cyclic)).toEqual({ a: 1, self: '[Filtered]' })
    let deep: unknown = 'bottom'
    for (let i = 0; i < 12; i++) deep = { next: deep }
    expect(JSON.stringify(scrubValue(deep))).toContain('"[Filtered]"')
  })

  it("keeps an error-like object's own name, message and stack, scrubbing their text", () => {
    expect(
      scrubValue({ name: 'validation_error', message: 'Invalid from a@b.co', statusCode: 422 }),
    ).toEqual({ name: 'validation_error', message: 'Invalid from [email]', statusCode: 422 })
    expect(scrubValue({ name: 'Ada', message: 'hi' })).toEqual({ name: 'Ada', message: 'hi' })
    expect(scrubValue({ name: 'Ada', team: 'x' })).toEqual({ name: '[Filtered]', team: 'x' })
  })

  it('passes other primitives through', () => {
    expect(scrubValue(3)).toBe(3)
    expect(scrubValue(null)).toBe(null)
    expect(scrubValue(undefined)).toBe(undefined)
  })
})

describe('scrubBreadcrumb', () => {
  it('drops console breadcrumbs', () => {
    expect(scrubBreadcrumb({ category: 'console', message: 'ada@example.com' })).toBeNull()
  })

  it('removes query strings from fetch and navigation URLs', () => {
    expect(
      scrubBreadcrumb({
        category: 'fetch',
        data: { method: 'GET', url: `/api/rpc/auth.verify?token=${TOKEN}`, status_code: 200 },
      }),
    ).toEqual({
      category: 'fetch',
      data: { method: 'GET', url: '/api/rpc/auth.verify', status_code: 200 },
    })
    expect(
      scrubBreadcrumb({
        category: 'navigation',
        data: { from: '/reset-password?token=abc', to: '/login?email=a%40b.co' },
      }),
    ).toEqual({ category: 'navigation', data: { from: '/reset-password', to: '/login' } })
  })

  it('scrubs the message and sensitive data keys of other breadcrumbs', () => {
    const crumb: Breadcrumb = {
      category: 'http',
      message: 'POST to grace@example.com',
      data: { 'http.query': '?token=abc', email: 'grace@example.com', status: 500 },
    }
    expect(scrubBreadcrumb(crumb)).toEqual({
      category: 'http',
      message: 'POST to [email]',
      data: { 'http.query': '[Filtered]', email: '[Filtered]', status: 500 },
    })
  })

  it("strips attributes from a click's selector, where aria-label can hold a name", () => {
    expect(
      scrubBreadcrumb({
        category: 'ui.click',
        message: 'header > button.rounded-full[type="button"][aria-label="Ada Lovelace"]',
      }),
    ).toEqual({ category: 'ui.click', message: 'header > button.rounded-full' })
  })

  it('leaves a breadcrumb with nothing to scrub as it was', () => {
    expect(scrubBreadcrumb({ category: 'ui.click' })).toEqual({ category: 'ui.click' })
  })
})

describe('scrubEvent', () => {
  it('removes the user, request body, cookies, headers and query string', () => {
    const scrubbed = scrubEvent(
      event({
        user: { id: '4', email: 'ada@example.com', ip_address: '203.0.113.9' },
        request: {
          method: 'POST',
          url: `https://action.pauseai.info/api/rpc/auth.login?token=${TOKEN}`,
          query_string: `token=${TOKEN}`,
          data: { email: 'ada@example.com', password: 'hunter2' },
          cookies: { session: TOKEN },
          headers: {
            'user-agent': 'Mozilla/5.0',
            authorization: `Bearer ${TOKEN}`,
            cookie: `session=${TOKEN}`,
            referer: 'https://action.pauseai.info/login?email=ada@example.com',
          },
          env: { REMOTE_ADDR: '203.0.113.9' },
        },
      }),
    )
    expect(scrubbed.user).toBeUndefined()
    expect(scrubbed.sdk?.settings?.infer_ip).toBe('never')
    expect(scrubbed.request).toEqual({
      method: 'POST',
      url: 'https://action.pauseai.info/api/rpc/auth.login',
      headers: { 'User-Agent': 'Mozilla/5.0' },
    })
  })

  it('keeps a request with no method, URL or user agent empty', () => {
    expect(scrubEvent(event({ request: { headers: { cookie: 'a=b' } } })).request).toEqual({})
  })

  it('scrubs messages, exception values, tags and extra data', () => {
    const scrubbed = scrubEvent(
      event({
        message: 'Failed for ada@example.com',
        logentry: { message: 'Failed for %s', params: ['ada@example.com'] },
        transaction: 'GET /verify-email?token=abc',
        tags: { route: '/login?email=ada@example.com' },
        extra: { log: '[EMAIL ERROR] to ada@example.com', name: 'Ada', hour: 12 },
        exception: {
          values: [
            {
              type: 'Error',
              value: 'Unique constraint failed: email "ada@example.com"',
              mechanism: { type: 'generic', handled: true, data: { email: 'ada@example.com' } },
              stacktrace: {
                frames: [
                  { filename: 'app/x.ts', lineno: 3, vars: { email: 'ada@example.com' } },
                  {
                    filename: 'https://action.pauseai.info/reset-password?token=abc#x',
                    abs_path: 'https://action.pauseai.info/login?email=ada@example.com',
                  },
                  {
                    filename: 'app/y.ts',
                    pre_context: ['const to = "ada@example.com"'],
                    context_line: 'send(to, "grace@example.com")',
                    post_context: ['// bob@example.com'],
                  },
                ],
              },
            },
            { type: 'TypeError' },
          ],
        },
      }),
    )
    expect(scrubbed.message).toBe('Failed for [email]')
    expect(scrubbed.logentry).toEqual({ message: 'Failed for %s', params: ['[email]'] })
    expect(scrubbed.transaction).toBe('GET /verify-email')
    expect(scrubbed.tags).toEqual({ route: '/login?[Filtered]' })
    expect(scrubbed.extra).toEqual({
      log: '[EMAIL ERROR] to [email]',
      name: '[Filtered]',
      hour: 12,
    })
    expect(scrubbed.exception?.values).toEqual([
      {
        type: 'Error',
        value: 'Unique constraint failed: email "[email]"',
        mechanism: { type: 'generic', handled: true, data: { email: '[Filtered]' } },
        stacktrace: {
          frames: [
            { filename: 'app/x.ts', lineno: 3 },
            {
              filename: 'https://action.pauseai.info/reset-password',
              abs_path: 'https://action.pauseai.info/login',
            },
            {
              filename: 'app/y.ts',
              pre_context: ['const to = "[email]"'],
              context_line: 'send(to, "[email]")',
              post_context: ['// [email]'],
            },
          ],
        },
      },
      { type: 'TypeError' },
    ])
  })

  it("keeps the SDK's runtime contexts but scrubs custom ones by key", () => {
    const scrubbed = scrubEvent(
      event({
        contexts: {
          os: { name: 'Linux' },
          runtime: { name: 'node', version: 'v24' },
          trace: { trace_id: '0123456789abcdef0123456789abcdef', span_id: '0123456789abcdef' },
          volunteer: { name: 'Ada', email: 'ada@example.com', id: 4 },
        },
      }),
    )
    expect(scrubbed.contexts).toEqual({
      os: { name: 'Linux' },
      runtime: { name: 'node', version: 'v24' },
      trace: { trace_id: '0123456789abcdef0123456789abcdef', span_id: '0123456789abcdef' },
      volunteer: { name: '[Filtered]', email: '[Filtered]', id: 4 },
    })
  })

  it('scrubs breadcrumbs carried on the event and drops console ones', () => {
    const scrubbed = scrubEvent(
      event({
        breadcrumbs: [
          { category: 'console', message: 'ada@example.com' },
          { category: 'navigation', data: { to: '/reset-password?token=abc' } },
        ],
      }),
    )
    expect(scrubbed.breadcrumbs).toEqual([
      { category: 'navigation', data: { to: '/reset-password' } },
    ])
  })

  it('does not change the event it was given', () => {
    const original = event({ user: { email: 'ada@example.com' }, message: 'ada@example.com' })
    scrubEvent(original)
    expect(original).toEqual(
      event({ user: { email: 'ada@example.com' }, message: 'ada@example.com' }),
    )
  })
})

describe('serverSentrySettings', () => {
  it('has no DSN when SENTRY_DSN is unset or blank', () => {
    expect(serverSentrySettings({}).dsn).toBeUndefined()
    expect(serverSentrySettings({ SENTRY_DSN: '  ' }).dsn).toBeUndefined()
  })

  it("takes the environment from SENTRY_ENVIRONMENT, then Railway's, then NODE_ENV", () => {
    const base = { SENTRY_DSN: 'https://k@o1.ingest.de.sentry.io/2' }
    expect(
      serverSentrySettings({
        ...base,
        SENTRY_ENVIRONMENT: 'staging',
        RAILWAY_ENVIRONMENT_NAME: 'production',
      }),
    ).toEqual({ dsn: base.SENTRY_DSN, environment: 'staging', release: undefined })
    expect(serverSentrySettings({ ...base, RAILWAY_ENVIRONMENT_NAME: 'pr-12' }).environment).toBe(
      'pr-12',
    )
    expect(serverSentrySettings({ ...base, NODE_ENV: 'production' }).environment).toBe('production')
    expect(serverSentrySettings(base).environment).toBe('development')
  })

  it('names the Render standby apart from production', () => {
    expect(
      serverSentrySettings({ RENDER: 'true', RAILWAY_ENVIRONMENT_NAME: 'production' }).environment,
    ).toBe('render-standby')
    expect(serverSentrySettings({ RENDER: 'true', SENTRY_ENVIRONMENT: 'x' }).environment).toBe('x')
  })

  it("tags the release with Railway's commit, else Render's", () => {
    expect(
      serverSentrySettings({ RAILWAY_GIT_COMMIT_SHA: 'abc', RENDER_GIT_COMMIT: 'def' }).release,
    ).toBe('abc')
    expect(serverSentrySettings({ RENDER_GIT_COMMIT: 'def' }).release).toBe('def')
  })
})

describe('browserSentryEnv', () => {
  it('inlines the same settings for the browser', () => {
    expect(
      browserSentryEnv({
        SENTRY_DSN: 'https://k@o1.ingest.de.sentry.io/2',
        RAILWAY_ENVIRONMENT_NAME: 'production',
        RAILWAY_GIT_COMMIT_SHA: 'abc',
      }),
    ).toEqual({
      NEXT_PUBLIC_SENTRY_DSN: 'https://k@o1.ingest.de.sentry.io/2',
      NEXT_PUBLIC_SENTRY_ENVIRONMENT: 'production',
      NEXT_PUBLIC_SENTRY_RELEASE: 'abc',
    })
  })

  it('inlines empty strings without a DSN, so the browser initialises nothing', () => {
    const inlined = browserSentryEnv({})
    expect(inlined.NEXT_PUBLIC_SENTRY_DSN).toBe('')
    expect(inlined.NEXT_PUBLIC_SENTRY_RELEASE).toBe('')
    expect(
      sentryOptions({
        dsn: inlined.NEXT_PUBLIC_SENTRY_DSN,
        environment: inlined.NEXT_PUBLIC_SENTRY_ENVIRONMENT,
      }),
    ).toBeUndefined()
  })
})

describe('sentryOrigin', () => {
  it("is the DSN's origin, for the CSP", () => {
    expect(sentryOrigin('https://key@o123.ingest.de.sentry.io/456')).toBe(
      'https://o123.ingest.de.sentry.io',
    )
  })

  it('is undefined without a DSN or for one that is not a URL', () => {
    expect(sentryOrigin(undefined)).toBeUndefined()
    expect(sentryOrigin('not a url')).toBeUndefined()
  })
})

describe('sentryOptions', () => {
  it('is undefined without a DSN, so Sentry is never initialised', () => {
    expect(sentryOptions({})).toBeUndefined()
    expect(sentryOptions({ dsn: '', environment: 'production' })).toBeUndefined()
  })

  it('collects no user info, bodies, cookies or query strings, has no tracing, and scrubs', () => {
    const options = sentryOptions({ dsn: 'https://k@o1.ingest.sentry.io/2', release: 'abc' })!
    expect(options).toMatchObject({
      dsn: 'https://k@o1.ingest.sentry.io/2',
      release: 'abc',
      environment: undefined,
      beforeSend: scrubEvent,
      beforeBreadcrumb: scrubBreadcrumb,
    })
    expect(options.dataCollection).toEqual({
      userInfo: false,
      cookies: false,
      httpHeaders: { request: { allow: ['user-agent'] }, response: false },
      httpBodies: [],
      urlQueryParams: false,
      graphQL: { document: false, variables: false },
      genAI: { inputs: false, outputs: false },
      mcp: { inputs: false, outputs: false },
      databaseQueryData: false,
      queues: false,
      stackFrameVariables: false,
    })
    expect(options).not.toHaveProperty('tracesSampleRate')
    expect(options).not.toHaveProperty('replaysSessionSampleRate')
    const integrations = options.integrations as (all: { name: string }[]) => { name: string }[]
    expect(
      integrations([{ name: 'BrowserSession' }, { name: 'Console' }, { name: 'Dedupe' }]),
    ).toEqual([{ name: 'Dedupe' }])
  })
})
