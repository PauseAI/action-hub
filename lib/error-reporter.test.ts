import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MemoryErrorReporter } from '@/test/fakes/error-reporter'
import { reportError, reportLoggedError, setErrorReporter } from './error-reporter'

const reporter = new MemoryErrorReporter()
beforeEach(() => reporter.install())
afterEach(() => reporter.uninstall())

describe('reportError', () => {
  it('reports the error, with any extra data', () => {
    const error = new Error('boom')
    reportError(error, { digest: 'abc' })
    expect(reporter.last).toEqual({ kind: 'exception', error, extra: { digest: 'abc' } })
    reportError(error)
    expect(reporter.last).toEqual({ kind: 'exception', error })
  })

  it('does nothing until a reporter is installed', () => {
    setErrorReporter(undefined)
    expect(() => reportError(new Error('boom'))).not.toThrow()
    expect(reporter.reports).toEqual([])
  })
})

describe('reportLoggedError', () => {
  const error = new Error('boom')

  it('reports logger.error(err, msg) as the exception, with the message', () => {
    reportLoggedError([error, '[EMAIL ERROR]'])
    expect(reporter.last).toEqual({ kind: 'exception', error, extra: { log: '[EMAIL ERROR]' } })
  })

  it('reports logger.error(err) with no extra data', () => {
    reportLoggedError([error])
    expect(reporter.last).toEqual({ kind: 'exception', error })
  })

  it('reports logger.error({ err, ...fields }, msg) with the fields', () => {
    reportLoggedError([{ err: error, hour: 3 }, '[CRON] failed'])
    expect(reporter.last).toEqual({
      kind: 'exception',
      error,
      extra: { hour: 3, log: '[CRON] failed' },
    })
  })

  it('reports a thrown non-Error value as the exception', () => {
    reportLoggedError([42, '[NOTIFY ERROR]'])
    expect(reporter.last).toEqual({
      kind: 'exception',
      error: 42,
      extra: { log: '[NOTIFY ERROR]' },
    })
  })

  it('reports logger.error(msg) and logger.error(fields, msg) as messages', () => {
    reportLoggedError(['[CRON] CRON_SECRET env var not set'])
    expect(reporter.last).toEqual({
      kind: 'message',
      message: '[CRON] CRON_SECRET env var not set',
      level: 'error',
    })
    reportLoggedError([{ hour: 3, cap: 10 }, '[EMAIL CAP] reached'])
    expect(reporter.last).toEqual({
      kind: 'message',
      message: '[EMAIL CAP] reached',
      level: 'error',
      extra: { hour: 3, cap: 10 },
    })
  })

  it('names a call with nothing to say after the logger', () => {
    reportLoggedError([])
    expect(reporter.last).toEqual({ kind: 'message', message: 'logger.error', level: 'error' })
  })
})
