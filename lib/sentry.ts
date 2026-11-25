import type { Breadcrumb, ErrorEvent, StackFrame, init } from '@sentry/nextjs'

/**
 * Sentry receives errors from the server, edge and browser runtimes. Action Hub holds
 * volunteers' personal data, so every event and breadcrumb passes through `scrubEvent` and
 * `scrubBreadcrumb` before it leaves the process: request bodies, cookies, headers other than
 * the user agent, query strings, the user, stack-frame variables, email and IP addresses, bearer
 * and session tokens, and values under keys that hold personal data are all removed.
 */

const FILTERED = '[Filtered]'

// Words that mark a key as holding personal data or credentials wherever they appear in it
// (`signalNumber`, `passwordHash`, `contactNotes`), covering the schema's personal and free-text
// fields.
const PERSONAL_WORDS =
  'name|e-?mail|phone|mobile|number|handle|signal|whatsapp|discord|location|address|postcode|' +
  'bio|note|message|content|body|subject|title|description|skill|interest|organi[sz]ation|' +
  'website|reason|summary|detail|password|passwd|hash|token|secret|cookie|session|auth|' +
  'credential|api[_-]?key'
const SENSITIVE_KEY = new RegExp(
  `${PERSONAL_WORDS}|^(?:ip|ip[_-]?address|zip|data|query|query[_-]?string|http\\.query|http\\.fragment)$`,
  'i',
)

const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9-]+(?:\.[A-Z0-9-]+)*\.[A-Z]{2,}/gi
const IPV4 = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g
// Full eight-group addresses, and compressed ones with `::` (which a clock time never has).
const IPV6 =
  /\b(?:[0-9a-f]{1,4}:){7}[0-9a-f]{1,4}\b|(?:\b(?:[0-9a-f]{1,4}:){0,5}[0-9a-f]{1,4}|(?<![\w:]))::(?:(?:[0-9a-f]{1,4}:)*(?:\d{1,3}(?:\.\d{1,3}){3}|[0-9a-f]{1,4}\b))?/gi
const BEARER = /\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]+/gi
// A query string after a URL or path: `?a=b&c=d`.
const QUERY = /\?[^\s"'<>#?]*=[^\s"'<>#]*/g
// `name: "Ada"`, `"signalNumber":"+44…"`, `firstName='Ada'`: quoted values under such keys.
const SENSITIVE_PAIR = new RegExp(
  `\\b(\\w*(?:${PERSONAL_WORDS})\\w*)(["']?\\s*[:=]\\s*)(["'\`])(?:(?!\\3)[^\\\\]|\\\\.)*\\3`,
  'gi',
)
// Postgres's constraint detail: `Key (email)=(ada@example.com) already exists.`
const PG_KEY = /(\bKey \([^)]*\)=\().*?(\) (?:already exists|is not present|is still referenced))/g
const PG_KEY_REST = /(\bKey \([^)]*\)=\()(?!\[Filtered\]\))[^\n]*/g
const PHONE = /\+\d[\d ().-]{6,}\d/g
// Prisma prints a failed call's arguments, values and all, between this line and its reason.
const PRISMA_CALL = /Invalid `[^`\n]*` invocation/
// Long opaque strings with letters and digits: session and verification tokens are 32 random
// bytes in base64url or hex.
const OPAQUE = /\b(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{32,}\b/g

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
    .replace(SENSITIVE_PAIR, `$1$2$3${FILTERED}$3`)
    .replace(PG_KEY, `$1${FILTERED}$2`)
    .replace(PG_KEY_REST, `$1${FILTERED})`)
    .replace(PHONE, '[phone]')
    .replace(QUERY, `?${FILTERED}`)
    .replace(OPAQUE, FILTERED)
}

/** A URL with its query string and fragment removed. */
export function scrubUrl(url: string): string {
  return scrubText(url.replace(/[?#][\s\S]*$/, ''))
}

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
  for (const [key, v] of Object.entries(value)) {
    out[key] = byKey && SENSITIVE_KEY.test(key) ? FILTERED : scrubValue(v, byKey, depth + 1, seen)
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

/** Drops console breadcrumbs, whose arguments can be anything, and scrubs the rest. */
export function scrubBreadcrumb(breadcrumb: Breadcrumb): Breadcrumb | null {
  if (breadcrumb.category === 'console') return null
  const out: Breadcrumb = { ...breadcrumb }
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

/** Drops a frame's local variables and scrubs the source lines sent around it. */
function scrubFrame({ vars: _vars, ...frame }: StackFrame): StackFrame {
  const out: StackFrame = { ...frame }
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
    environment: e.SENTRY_ENVIRONMENT || e.RAILWAY_ENVIRONMENT_NAME || e.NODE_ENV || 'development',
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
