import { scrubText } from './sentry'

/**
 * Where errors are reported beyond the logs. Nothing is reported until a runtime that has
 * initialised Sentry installs a reporter with `setErrorReporter` (see `sentryOptions`).
 */
type Level = 'error' | 'fatal'
type Hint = { level?: Level; extra?: Record<string, unknown> }

export type ErrorReporter = {
  captureException(error: unknown, hint?: Hint): unknown
  captureMessage(message: string, hint?: Hint): unknown
}

// On globalThis because Next bundles instrumentation.ts apart from the routes, and each bundle
// can hold its own copy of this module.
const KEY = Symbol.for('action-hub.error-reporter')
type Holder = { [KEY]?: ErrorReporter }

export function setErrorReporter(reporter: ErrorReporter | undefined): void {
  ;(globalThis as Holder)[KEY] = reporter
}

function reporter(): ErrorReporter | undefined {
  return (globalThis as Holder)[KEY]
}

/**
 * Reports an error caught by an error boundary. One with a `digest` was thrown on the server,
 * which reported it through `onRequestError`; the browser holds only Next's redacted copy.
 */
export function reportClientError(error: unknown): void {
  if ((error as { digest?: unknown } | null)?.digest) return
  reporter()?.captureException(error)
}

// One outage can log the same error once per recipient of a digest; a few of each per minute
// say as much as thousands, and leave the quota for everything else.
const THROTTLE_WINDOW_MS = 60_000
const THROTTLE_MAX = 5
const MAX_THROTTLE_KEYS = 1000
const throttle = new Map<string, { start: number; count: number }>()

function throttled(key: string): boolean {
  const now = Date.now()
  const seen = throttle.get(key)
  if (!seen || now - seen.start >= THROTTLE_WINDOW_MS) {
    if (throttle.size >= MAX_THROTTLE_KEYS) throttle.clear()
    throttle.set(key, { start: now, count: 1 })
    return false
  }
  seen.count += 1
  return seen.count > THROTTLE_MAX
}

/** Forgets which logged errors were reported, so each test starts with none throttled. */
export function resetReportThrottle(): void {
  throttle.clear()
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null

const FATAL_LEVEL = 60

/**
 * Reports one `logger.error` or `logger.fatal` call, given pino's arguments and level: `(err,
 * msg?)`, `({ err, ...fields }, msg?)`, `(fields, msg?)` or `(msg)`. The error goes as an
 * exception, with the message and any other fields as extra data; a call with no error goes as
 * a message. More than a few of the same error a minute are dropped.
 */
export function reportLoggedError(args: unknown[], pinoLevel = 50): void {
  const [first, ...rest] = args
  const message = typeof first === 'string' ? first : rest.find((a) => typeof a === 'string')
  let error: unknown
  let fields: Record<string, unknown> = {}
  if (first instanceof Error) {
    error = first
  } else if (isRecord(first)) {
    const { err, ...others } = first
    error = err
    fields = others
  } else if (first !== undefined && typeof first !== 'string') {
    error = first
  }
  const level: Level = pinoLevel >= FATAL_LEVEL ? 'fatal' : 'error'
  // Scrubbed, so an error naming each recipient of a failing digest is throttled as one.
  const errorText = error instanceof Error ? `${error.name}: ${error.message}` : typeof error
  if (throttled(scrubText(`${message ?? ''}\n${error === undefined ? '' : errorText}`))) return

  const hasFields = Object.keys(fields).length > 0
  if (error === undefined) {
    reporter()?.captureMessage(message ?? 'logger.error', {
      level,
      ...(hasFields ? { extra: fields } : {}),
    })
    return
  }
  const extra = { ...fields, ...(message ? { log: message } : {}) }
  reporter()?.captureException(error, {
    level,
    ...(Object.keys(extra).length > 0 ? { extra } : {}),
  })
}
