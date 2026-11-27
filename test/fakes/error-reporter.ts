import type { ErrorReporter } from '@/lib/error-reporter'

type Hint = { level?: string; extra?: Record<string, unknown> }
type Report = ({ kind: 'exception'; error: unknown } | { kind: 'message'; message: string }) & Hint

/**
 * Holds what would have gone to Sentry. `test/setup-db.ts` installs one per test file as
 * `errorReports` and empties it before each test.
 */
export class MemoryErrorReporter implements ErrorReporter {
  reports: Report[] = []

  captureException(error: unknown, hint?: Hint) {
    this.reports.push({ kind: 'exception', error, ...hint })
  }

  captureMessage(message: string, hint?: Hint) {
    this.reports.push({ kind: 'message', message, ...hint })
  }

  get last(): Report | undefined {
    return this.reports.at(-1)
  }

  reset(): void {
    this.reports = []
  }
}

export const errorReports = new MemoryErrorReporter()
