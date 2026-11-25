/**
 * Where errors are reported beyond the logs. Nothing is reported until a runtime that has
 * initialised Sentry (instrumentation.ts, instrumentation-client.ts) installs it with
 * `setErrorReporter`, so without a DSN every call here does nothing.
 */
export type ErrorReporter = {
  captureException(error: unknown, hint?: { extra?: Record<string, unknown> }): unknown
  captureMessage(
    message: string,
    hint?: { level?: 'error'; extra?: Record<string, unknown> },
  ): unknown
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

/** Reports an error caught by an error boundary or handler. */
export function reportError(error: unknown, extra?: Record<string, unknown>): void {
  reporter()?.captureException(error, extra ? { extra } : undefined)
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null

/**
 * Reports one `logger.error` call, given pino's arguments: `(err, msg?)`, `({ err, ...fields },
 * msg?)`, `(fields, msg?)` or `(msg)`. The error goes as an exception, with the message and
 * any other fields as extra data; a call with no error goes as a message.
 */
export function reportLoggedError(args: unknown[]): void {
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
  if (error === undefined) {
    const hasFields = Object.keys(fields).length > 0
    reporter()?.captureMessage(message ?? 'logger.error', {
      level: 'error',
      ...(hasFields ? { extra: fields } : {}),
    })
    return
  }
  const extra = { ...fields, ...(message ? { log: message } : {}) }
  reporter()?.captureException(error, Object.keys(extra).length > 0 ? { extra } : undefined)
}
