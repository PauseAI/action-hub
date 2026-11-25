'use client'

import { useEffect } from 'react'
import { reportError } from '@/lib/error-reporter'

/**
 * Replaces the root layout when it fails to render, so it brings its own document and none of
 * the app's styles or providers.
 */
export default function GlobalError({ error, retry }: { error: unknown; retry: () => void }) {
  useEffect(() => {
    console.error(error)
    // An error with a digest was thrown on the server, which has already reported it.
    if (!(error as { digest?: unknown } | null)?.digest) reportError(error)
  }, [error])

  return (
    <html lang="en">
      <body
        style={{ fontFamily: 'system-ui, sans-serif', textAlign: 'center', padding: '4rem 1rem' }}
      >
        <title>Action Hub | Something went wrong</title>
        <h1>Something went wrong</h1>
        <p>An unexpected error occurred. You can try again, or head back home.</p>
        <p>
          <button type="button" onClick={() => retry()}>
            Try again
          </button>{' '}
          {/* A full page load, so the root layout that failed is rendered afresh. */}
          {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
          <a href="/">Go home</a>
        </p>
      </body>
    </html>
  )
}
