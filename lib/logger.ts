import pino from 'pino'
import pretty from 'pino-pretty'
import { env } from './env'
import { reportLoggedError } from './error-reporter'

const ERROR_LEVEL = 50

/** Every `logger.error` and `logger.fatal` is also sent to the error reporter. */
const hooks: pino.LoggerOptions['hooks'] = {
  logMethod(args, method, level) {
    if (level >= ERROR_LEVEL) {
      // Reporting must never stop the line being logged, or throw out of a catch handler.
      try {
        reportLoggedError(args, level)
      } catch {}
    }
    return method.apply(this, args)
  },
}

/** Silent in tests, structured JSON in production, pretty-printed everywhere else. */
export function loggerOptions(nodeEnv: string): pino.LoggerOptions {
  if (nodeEnv === 'test') return { level: 'silent' }
  if (nodeEnv === 'production') return { level: 'info', hooks }
  return { level: 'debug', hooks }
}

/**
 * Pretty-printing outside production runs as a plain in-thread stream rather than pino's
 * worker-thread transport, so a script's `logger.error(...); process.exit(1)` can't race the
 * worker and drop the message it was written for.
 */
export function loggerDestination(nodeEnv: string): pino.DestinationStream | undefined {
  if (nodeEnv === 'test' || nodeEnv === 'production') return undefined
  return pretty({ colorize: true, ignore: 'pid,hostname' })
}

/** Server-side structured logger: never imported from client components or the browser bundle. */
export const logger = pino(loggerOptions(env.NODE_ENV), loggerDestination(env.NODE_ENV))
