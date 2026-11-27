import type { Breadcrumb, ErrorEvent, StackFrame, init } from '@sentry/nextjs'

/**
 * Sentry receives errors from the server, edge and browser runtimes. Action Hub holds
 * volunteers' personal data, so every event and breadcrumb passes through `scrubEvent` and
 * `scrubBreadcrumb` before it leaves the process: request bodies, cookies, headers other than
 * the user agent, query strings, the user, stack-frame variables, email and IP addresses, bearer
 * and session tokens, and values under keys that hold personal data are all removed.
 */

const FILTERED = '[Filtered]'

// A key holds personal data or a credential when one of its words (camelCase, snake_case,
// kebab-case or dotted) is one of these, so `signalNumber`, `passwordHash`, `contactNotes` and
// `aria-label` are caught and `filename` and `hostname` are not.
const PERSONAL_WORDS = new Set(
  (
    'name surname nickname username firstname lastname fullname email mail phone mobile number ' +
    'handle signal whatsapp discord location address postcode zip bio note notes message content ' +
    'body subject title description skill skills interest interests organisation organization ' +
    'website reason summary detail details password passwd pwd hash token secret cookie cookies ' +
    'session auth authorization credential credentials apikey ip query data label alt'
  ).split(' '),
)

function keyWords(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
}

/** Whether a key names personal data or a credential. */
export function isSensitiveKey(key: string): boolean {
  const words = keyWords(key)
  return words.some((w) => PERSONAL_WORDS.has(w)) || words.join('').includes('apikey')
}

const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9-]+(?:\.[A-Z0-9-]+)*\.[A-Z]{2,}/gi
const IPV4 = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g
// Full eight-group addresses, and compressed ones with `::` (which a clock time never has).
const IPV6 =
  /\b(?:[0-9a-f]{1,4}:){7}[0-9a-f]{1,4}\b|(?:\b(?:[0-9a-f]{1,4}:){0,5}[0-9a-f]{1,4}|(?<![\w:]))::(?:(?:[0-9a-f]{1,4}:)*(?:\d{1,3}(?:\.\d{1,3}){3}|[0-9a-f]{1,4}\b))?/gi
const BEARER = /\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]+/gi
// A query string after a URL or path: `?a=b&c=d`.
const QUERY = /\?[^\s"'<>#?]*=[^\s"'<>#]*/g
// `key: "value"`, `"key":"value"`, `key='value'` and `key=value words`: Prisma's and Node's
// dumps, JSON and form bodies. An unquoted value runs to the next delimiter or key, and never
// takes in a brace, so a sensitive pair nested inside it is still reached.
const PAIR =
  /\b([A-Za-z_][\w.-]*)(["']?\s*[:=]\s*)(?:(["'`])((?:(?!\3)[^\\]|\\.)*)\3|([^\s"'`,;&{}[\]()<>]+(?: [^\s"'`,;&{}[\]()<>:=]+)*))/g
// Postgres's constraint detail: `Key (email)=(ada@example.com) already exists.`
const PG_KEY = /(\bKey \([^)]*\)=\().*?(\) (?:already exists|is not present|is still referenced))/g
const PG_KEY_REST = /(\bKey \([^)]*\)=\()(?!\[Filtered\]\))[^\n]*/g
const PHONE = /\+\d[\d ().-]{6,}\d/g
// National format, such as `07700 900123` and `020-7946-0958`.
const NATIONAL_PHONE = /(?<![\w.])0\d(?:[ -]?\d){8,10}(?![\w.])/g
// Prisma prints a failed call's arguments, values and all, between this line and its reason.
const PRISMA_CALL = /Invalid `[^`\n]*` invocation/
// Session and verification tokens are 32 random bytes in base64url (43 characters) or hex (64):
// any run of 32 or more with letters and digits, and any of 40 or more, as one in about 1,500
// base64url tokens has no digit.
const OPAQUE = /\b(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{32,}\b/g
const LONG_OPAQUE = /\b[A-Za-z0-9_-]{40,}\b/g

/** Keeps a Prisma error's first line and its closing reason, dropping the arguments between. */
function cutPrismaArguments(text: string): string {
  const call = PRISMA_CALL.exec(text)
  if (!call) return text
  const paragraphs = text.slice(call.index).split(/\n\s*\n/)
  const reason = paragraphs.length > 1 ? `\n\n${paragraphs[paragraphs.length - 1]}` : ''
  return `${text.slice(0, call.index)}${call[0]}: [arguments filtered]${reason}`
}

/** Removes personal data and credentials from free text. */
export function scrubText(text: string): string {
  return cutPrismaArguments(text)
    .replace(EMAIL, '[email]')
    .replace(IPV6, '[ip]')
    .replace(IPV4, '[ip]')
    .replace(BEARER, `$1 ${FILTERED}`)
    .replace(PAIR, (pair, key: string, separator: string, quote?: string) => {
      if (!isSensitiveKey(key)) return pair
      return quote
        ? `${key}${separator}${quote}${FILTERED}${quote}`
        : `${key}${separator}${FILTERED}`
    })
    .replace(PG_KEY, `$1${FILTERED}$2`)
    .replace(PG_KEY_REST, `$1${FILTERED})`)
    .replace(PHONE, '[phone]')
    .replace(NATIONAL_PHONE, '[phone]')
    .replace(QUERY, `?${FILTERED}`)
    .replace(OPAQUE, FILTERED)
    .replace(LONG_OPAQUE, FILTERED)
}

/** A URL with its query string and fragment removed. */
export function scrubUrl(url: string): string {
  return scrubText(url.replace(/[?#][\s\S]*$/, ''))
}

// An error-like object's own fields say what went wrong; their text is still scrubbed.
const ERROR_FIELDS = new Set(['name', 'message', 'stack', 'code'])
const isErrorLike = (v: Record<string, unknown>) =>
  typeof v.message === 'string' && (typeof v.name === 'string' || typeof v.stack === 'string')

/**
 * Copies a value with every string scrubbed and, when `byKey` is set, every sensitive key's
 * value replaced. Cycles and anything deeper than a few levels become `[Filtered]`.
 */
export function scrubValue(value: unknown, byKey = true, depth = 0, seen = new WeakSet()): unknown {
  if (typeof value === 'string') return scrubText(value)
  if (value === null || typeof value !== 'object') return value
  if (depth > 8 || seen.has(value)) return FILTERED
  seen.add(value)
  if (Array.isArray(value)) return value.map((v) => scrubValue(v, byKey, depth + 1, seen))
  const out: Record<string, unknown> = {}
  const errorLike = isErrorLike(value as Record<string, unknown>)
  for (const [key, v] of Object.entries(value)) {
    const sensitive = byKey && isSensitiveKey(key) && !(errorLike && ERROR_FIELDS.has(key))
    out[key] = sensitive ? FILTERED : scrubValue(v, byKey, depth + 1, seen)
  }
  return out
}

const scrubRecord = <T>(value: T, byKey = true): T => scrubValue(value, byKey) as T

// Contexts the SDK fills from the runtime (`os.name`, `browser.name`): their keys are not
// personal data, only their strings are scrubbed.
const SDK_CONTEXTS = new Set([
  'app',
  'browser',
  'cloud_resource',
  'culture',
  'device',
  'os',
  'response',
  'runtime',
])

// Each fetch, xhr and navigation breadcrumb's URL fields.
const URL_FIELDS = ['url', 'from', 'to']

/**
 * Drops console breadcrumbs, whose arguments can be anything, and scrubs the rest. A click or
 * input breadcrumb's selector loses its attributes, as `aria-label` and `title` often hold a
 * person's name.
 */
export function scrubBreadcrumb(breadcrumb: Breadcrumb): Breadcrumb | null {
  if (breadcrumb.category === 'console') return null
  const out: Breadcrumb = { ...breadcrumb }
  if (out.message && out.category?.startsWith('ui.')) {
    out.message = out.message.replace(/\[[^\]]*\]/g, '')
  }
  if (out.message) out.message = scrubText(out.message)
  if (out.data) {
    const data: Record<string, unknown> = { ...out.data }
    for (const field of URL_FIELDS) {
      if (typeof data[field] === 'string') data[field] = scrubUrl(data[field])
    }
    out.data = scrubRecord(data)
  }
  return out
}

/**
 * Drops a frame's local variables and scrubs the source lines sent around it, and its file,
 * which for an inline script is the page's URL, query string and all.
 */
function scrubFrame({ vars: _vars, ...frame }: StackFrame): StackFrame {
  const out: StackFrame = { ...frame }
  if (out.filename) out.filename = scrubUrl(out.filename)
  if (out.abs_path) out.abs_path = scrubUrl(out.abs_path)
  if (out.context_line) out.context_line = scrubText(out.context_line)
  if (out.pre_context) out.pre_context = out.pre_context.map(scrubText)
  if (out.post_context) out.post_context = out.post_context.map(scrubText)
  return out
}

/** Removes personal data and credentials from an event before it is sent. */
export function scrubEvent(event: ErrorEvent): ErrorEvent {
  const out: ErrorEvent = { ...event }
  delete out.user
  // Without this, Sentry fills in the address the event was sent from.
  out.sdk = { ...out.sdk, settings: { ...out.sdk?.settings, infer_ip: 'never' } }

  if (out.request) {
    const { method, url, headers } = out.request
    const userAgent = headers?.['user-agent'] ?? headers?.['User-Agent']
    out.request = {
      ...(method ? { method } : {}),
      ...(url ? { url: scrubUrl(url) } : {}),
      ...(userAgent ? { headers: { 'User-Agent': userAgent } } : {}),
    }
  }

  if (out.message) out.message = scrubText(out.message)
  if (out.logentry) out.logentry = scrubRecord(out.logentry, false)
  if (out.transaction) out.transaction = scrubUrl(out.transaction)
  if (out.tags) out.tags = scrubRecord(out.tags, false)
  if (out.extra) out.extra = scrubRecord(out.extra)

  if (out.contexts) {
    out.contexts = Object.fromEntries(
      Object.entries(out.contexts).map(([name, context]) => [
        name,
        // Trace and span ids are random hex that the opaque-token rule would remove.
        name === 'trace' ? context : scrubRecord(context, !SDK_CONTEXTS.has(name)),
      ]),
    )
  }

  if (out.exception?.values) {
    out.exception = {
      ...out.exception,
      values: out.exception.values.map((exception) => ({
        ...exception,
        ...(exception.value ? { value: scrubText(exception.value) } : {}),
        ...(exception.mechanism?.data
          ? { mechanism: { ...exception.mechanism, data: scrubRecord(exception.mechanism.data) } }
          : {}),
        ...(exception.stacktrace?.frames
          ? {
              stacktrace: {
                ...exception.stacktrace,
                frames: exception.stacktrace.frames.map(scrubFrame),
              },
            }
          : {}),
      })),
    }
  }

  if (out.breadcrumbs) {
    out.breadcrumbs = out.breadcrumbs
      .map(scrubBreadcrumb)
      .filter((b): b is Breadcrumb => b !== null)
  }

  return out
}

/** What a runtime knows about its deploy; each is read from the environment by its caller. */
export type SentrySettings = {
  dsn?: string
  environment?: string
  release?: string
}

type Env = Record<string, string | undefined>

/** The server's and edge runtime's settings, read from their environment at start-up. */
export function serverSentrySettings(e: Env = process.env): SentrySettings {
  return {
    dsn: e.SENTRY_DSN?.trim() || undefined,
    environment:
      e.SENTRY_ENVIRONMENT ||
      // Render sets RENDER; the standby also sets RAILWAY_ENVIRONMENT_NAME, to production.
      (e.RENDER ? 'render-standby' : undefined) ||
      e.RAILWAY_ENVIRONMENT_NAME ||
      e.NODE_ENV ||
      'development',
    release: e.RAILWAY_GIT_COMMIT_SHA || e.RENDER_GIT_COMMIT || undefined,
  }
}

/**
 * The browser's settings, inlined at build time by next.config.ts as `NEXT_PUBLIC_SENTRY_*`
 * from the same variables the server reads.
 */
export function browserSentryEnv(e: Env = process.env): Record<string, string> {
  const s = serverSentrySettings(e)
  return {
    NEXT_PUBLIC_SENTRY_DSN: s.dsn ?? '',
    NEXT_PUBLIC_SENTRY_ENVIRONMENT: s.environment ?? '',
    NEXT_PUBLIC_SENTRY_RELEASE: s.release ?? '',
  }
}

/** The origin events are posted to, for the CSP's connect-src; undefined without a DSN. */
export function sentryOrigin(dsn: string | undefined): string | undefined {
  if (!dsn) return undefined
  try {
    return new URL(dsn).origin
  } catch {
    return undefined
  }
}

// The browser's release-health sessions ask Sentry to record each visitor's IP address, and
// console breadcrumbs would only be dropped by scrubBreadcrumb.
const DROPPED_INTEGRATIONS = new Set(['BrowserSession', 'Console'])

type SentryOptions = Parameters<typeof init>[0]

/**
 * `Sentry.init` options shared by every runtime, or undefined without a DSN so that Sentry is
 * never initialised. No tracing, session replay or browser sessions, and the SDK collects
 * as little as it can before the scrubbers run: its defaults collect everything.
 */
export function sentryOptions(settings: SentrySettings): SentryOptions | undefined {
  if (!settings.dsn) return undefined
  return {
    dsn: settings.dsn,
    environment: settings.environment || undefined,
    release: settings.release || undefined,
    dataCollection: {
      // Also stops Sentry filling in the IP address the event came from.
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
    },
    // No tracesSampleRate: tracing stays off and no transactions are sent.
    beforeSend: scrubEvent,
    beforeBreadcrumb: scrubBreadcrumb,
    integrations: (defaults) =>
      defaults.filter((integration) => !DROPPED_INTEGRATIONS.has(integration.name)),
  }
}
