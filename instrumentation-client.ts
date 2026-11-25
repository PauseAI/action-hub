import { captureException, captureMessage, init } from '@sentry/nextjs'
import { z } from 'zod'
import { setErrorReporter } from './lib/error-reporter'
import { sentryOptions } from './lib/sentry'

// Zod probes whether it may compile validators with `new Function`; the CSP (next.config.ts)
// forbids that, so the probe only files a violation report. Skip it and use the interpreter.
z.config({ jitless: true })

// next.config.ts inlines these from SENTRY_DSN and the deploy's variables at build time. In a
// build without SENTRY_DSN the condition is a constant '', so the SDK is left out of the bundle.
if (process.env.NEXT_PUBLIC_SENTRY_DSN) {
  const options = sentryOptions({
    dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
    environment: process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT,
    release: process.env.NEXT_PUBLIC_SENTRY_RELEASE,
  })
  if (options) {
    init(options)
    setErrorReporter({ captureException, captureMessage })
  }
}
