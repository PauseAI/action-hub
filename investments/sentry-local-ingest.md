# See what a build sends to Sentry, locally

Size: S. Kind: tools.

## Problem

`lib/sentry.ts` scrubs events before they leave, and its unit tests check the scrubber and one
real client, but the only way to see what a production build actually sends from the server,
the logger and the browser is to point `SENTRY_DSN` at a throwaway HTTP server that records
envelopes, add routes that throw, build, and read the envelopes by hand. Every change to the
scrubber or to what the SDK collects needs that again.

## Fix

A script (`npm run sentry:capture`) that starts a local ingest on a free port, builds with
`SENTRY_DSN` pointed at it, serves the build, triggers a server render error, a `logger.error`
and a client boundary error with known personal data in the request, and fails if any of it
appears in a captured envelope. It could run in CI beside the e2e suite.

## Hits

- 2026-11-25: wrote a throwaway envelope recorder and temporary throwing routes to check the
  first Sentry integration end to end, ~30 min
