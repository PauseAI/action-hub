import pino from 'pino'
import { afterEach, describe, expect, it } from 'vitest'
import { MemoryErrorReporter } from '@/test/fakes/error-reporter'
import { logger, loggerDestination, loggerOptions } from './logger'

describe('loggerOptions', () => {
  it('is silent in tests', () => {
    expect(loggerOptions('test')).toEqual({ level: 'silent' })
  })

  it('logs structured JSON at info level in production', () => {
    expect(loggerOptions('production')).toMatchObject({ level: 'info' })
  })

  it('logs at debug level everywhere else', () => {
    expect(loggerOptions('development')).toMatchObject({ level: 'debug' })
  })
})

describe('error reporting', () => {
  const reporter = new MemoryErrorReporter()
  afterEach(() => reporter.uninstall())

  function productionLogger() {
    const lines: string[] = []
    const log = pino(loggerOptions('production'), { write: (line: string) => lines.push(line) })
    return { log, lines }
  }

  it('reports every error and fatal log, and still writes it', () => {
    reporter.install()
    const { log, lines } = productionLogger()
    const error = new Error('boom')
    log.error(error, '[EMAIL ERROR]')
    log.fatal('[MIGRATE] gave up')
    expect(reporter.reports).toEqual([
      { kind: 'exception', error, extra: { log: '[EMAIL ERROR]' } },
      { kind: 'message', message: '[MIGRATE] gave up', level: 'error' },
    ])
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[0])).toMatchObject({ level: 50, msg: '[EMAIL ERROR]' })
  })

  it('reports nothing below error level', () => {
    reporter.install()
    const { log, lines } = productionLogger()
    log.warn('[EMAIL] slow')
    log.info('started')
    expect(reporter.reports).toEqual([])
    expect(lines).toHaveLength(2)
  })

  it('reports nothing in development without a reporter installed', () => {
    const log = pino(loggerOptions('development'), { write: () => {} })
    expect(() => log.error(new Error('boom'))).not.toThrow()
    expect(reporter.reports).toEqual([])
  })
})

describe('loggerDestination', () => {
  it('has no pretty-printing stream in tests', () => {
    expect(loggerDestination('test')).toBeUndefined()
  })

  it('has no pretty-printing stream in production', () => {
    expect(loggerDestination('production')).toBeUndefined()
  })

  it('pretty-prints to a plain in-thread stream everywhere else', () => {
    const stream = loggerDestination('development')
    expect(stream).toBeDefined()
    expect(typeof stream?.write).toBe('function')
  })
})

describe('logger', () => {
  it('is a pino instance silenced for the test environment', () => {
    expect(typeof logger.info).toBe('function')
    expect(typeof logger.warn).toBe('function')
    expect(typeof logger.error).toBe('function')
    expect(logger.level).toBe('silent')
  })
})
