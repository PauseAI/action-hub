import { setErrorReporter, type ErrorReporter } from '@/lib/error-reporter'

type Report =
  | { kind: 'exception'; error: unknown; extra?: Record<string, unknown> }
  | { kind: 'message'; message: string; level?: string; extra?: Record<string, unknown> }

/** Holds what would have gone to Sentry. `install()` makes it the reporter; `uninstall()` clears it. */
export class MemoryErrorReporter implements ErrorReporter {
  reports: Report[] = []

  captureException(error: unknown, hint?: { extra?: Record<string, unknown> }) {
    this.reports.push({ kind: 'exception', error, ...hint })
  }

  captureMessage(message: string, hint?: { level?: 'error'; extra?: Record<string, unknown> }) {
    this.reports.push({ kind: 'message', message, ...hint })
  }

  get last(): Report | undefined {
    return this.reports.at(-1)
  }

  install(): this {
    this.reports = []
    setErrorReporter(this)
    return this
  }

  uninstall(): void {
    setErrorReporter(undefined)
  }
}
