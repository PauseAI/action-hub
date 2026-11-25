import { afterEach, describe, expect, it, vi } from 'vitest'
import { errorReports } from '@/test/fakes/error-reporter'
import { reportError, reportLoggedError, setErrorReporter } from './error-reporter'

afterEach(() => {
  setErrorReporter(errorReports)
  vi.useRealTimers()
})

describe('reportError', () => {
  it('reports the error', () => {
    const error = new Error('boom')
    reportError(error)
    expect(errorReports.last).toEqual({ kind: 'exception', error })
  })

  it('does nothing without a reporter installed', () => {
    setErrorReporter(undefined)
    expect(() => reportError(new Error('boom'))).not.toThrow()
    expect(() => reportLoggedError([new Error('boom')])).not.toThrow()
    expect(errorReports.reports).toEqual([])
  })
})

describe('reportLoggedError', () => {
  const error = new Error('boom')

  it('reports logger.error(err, msg) as the exception, with the message', () => {
    reportLoggedError([error, '[EMAIL ERROR]'])
    expect(errorReports.last).toEqual({
      kind: 'exception',
      error,
      level: 'error',
      extra: { log: '[EMAIL ERROR]' },
    })
  })

  it('reports logger.error(err) with no extra data', () => {
    reportLoggedError([error])
    expect(errorReports.last).toEqual({ kind: 'exception', error, level: 'error' })
  })

  it('reports logger.error({ err, ...fields }, msg) with the fields', () => {
    reportLoggedError([{ err: error, hour: 3 }, '[CRON] failed'])
    expect(errorReports.last).toEqual({
      kind: 'exception',
      error,
      level: 'error',
      extra: { hour: 3, log: '[CRON] failed' },
    })
  })

  it('reports a thrown non-Error value as the exception', () => {
    reportLoggedError([42, '[NOTIFY ERROR]'])
    expect(errorReports.last).toEqual({
      kind: 'exception',
      error: 42,
      level: 'error',
      extra: { log: '[NOTIFY ERROR]' },
    })
  })

  it('reports logger.error(msg) and logger.error(fields, msg) as messages', () => {
    reportLoggedError(['[CRON] CRON_SECRET env var not set'])
    expect(errorReports.last).toEqual({
      kind: 'message',
      message: '[CRON] CRON_SECRET env var not set',
      level: 'error',
    })
    reportLoggedError([{ hour: 3, cap: 10 }, '[EMAIL CAP] reached'])
    expect(errorReports.last).toEqual({
      kind: 'message',
      message: '[EMAIL CAP] reached',
      level: 'error',
      extra: { hour: 3, cap: 10 },
    })
  })

  it('names a call with nothing to say after the logger', () => {
    reportLoggedError([])
    expect(errorReports.last).toEqual({ kind: 'message', message: 'logger.error', level: 'error' })
  })

  it('reports pino level 60 as fatal', () => {
    reportLoggedError(['[MIGRATE] gave up'], 60)
    reportLoggedError([error, '[MIGRATE]'], 60)
    expect(errorReports.reports.map((r) => r.level)).toEqual(['fatal', 'fatal'])
  })

  it('reports at most five of the same error a minute, and others meanwhile', () => {
    vi.useFakeTimers()
    for (let i = 0; i < 20; i++) reportLoggedError([new Error('Resend down'), '[EMAIL ERROR]'])
    reportLoggedError([new Error('other'), '[EMAIL ERROR]'])
    expect(errorReports.reports).toHaveLength(6)
    vi.advanceTimersByTime(60_000)
    reportLoggedError([new Error('Resend down'), '[EMAIL ERROR]'])
    expect(errorReports.reports).toHaveLength(7)
  })

  it('forgets every key once it holds too many, rather than growing without end', () => {
    for (let i = 0; i < 1001; i++) reportLoggedError([`[X] ${i}`])
    reportLoggedError(['[X] 0'])
    expect(errorReports.reports).toHaveLength(1002)
  })
})
