// Calls /api/cron/daily once and exits non-zero if it fails. Run hourly by the cron service
// (railway.cron.toml), which carries only Node and this file, so it imports nothing but Node.
//
// Environment:
//   CRON_SECRET            required; sent as the bearer token
//   CRON_URL               optional; defaults to production's /api/cron/daily
//   CRON_HEALTHCHECK_URL   optional; a healthchecks.io ping URL (https://hc-ping.com/<uuid>).
//                          The run pings <url>/start, then <url> on success or <url>/fail
//                          otherwise, with the status and response as the body, so a run that
//                          fails or never starts raises an alert. Unset, nothing is pinged.
//
// A run fails on a non-2xx response, a network error, or any job in the response reporting
// `{ error }` or `{ failed: n > 0 }`: the route answers 200 when a single job throws
// (runScheduledJobs in lib/cron-jobs.ts), and a job that counts its own failures returns them.
import { realpathSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const DEFAULT_URL = 'https://action.pauseai.info/api/cron/daily'
// The call waits for every job due this hour, a backup included.
const REQUEST_TIMEOUT_MS = 15 * 60_000
const PING_TIMEOUT_MS = 10_000
// healthchecks.io keeps the first 100 KB of a ping body; a few KB is enough to read a run.
const PING_BODY_LIMIT = 4_000

/** Names of the jobs whose result in the route's JSON is `{ error }` or `{ failed: n > 0 }`. */
function failedJobs(body) {
  let results
  try {
    results = JSON.parse(body)
  } catch {
    return []
  }
  if (!results || typeof results !== 'object') return []
  return Object.entries(results)
    .filter(([, r]) => r && typeof r === 'object' && ('error' in r || r.failed > 0))
    .map(([name]) => name)
}

/**
 * Runs the trigger and returns the process exit code. A healthcheck ping never changes it:
 * each is bounded by a short timeout and its failure is only logged.
 *
 * @param {{
 *   env?: Record<string, string | undefined>,
 *   fetch?: typeof globalThis.fetch,
 *   log?: Pick<Console, 'log' | 'error'>,
 *   pingTimeoutMs?: number,
 * }} [options]
 * @returns {Promise<number>}
 */
export async function run({
  env = process.env,
  fetch = globalThis.fetch,
  log = console,
  pingTimeoutMs = PING_TIMEOUT_MS,
} = {}) {
  const url = env.CRON_URL?.trim() || DEFAULT_URL
  const secret = env.CRON_SECRET
  const healthcheck = env.CRON_HEALTHCHECK_URL?.trim()
  const redact = (text) => (secret ? text.replaceAll(secret, '[redacted]') : text)

  const ping = async (suffix, body = '') => {
    if (!healthcheck) return
    let text = redact(body)
    if (text.length > PING_BODY_LIMIT) text = `${text.slice(0, PING_BODY_LIMIT)}\n…[truncated]`
    try {
      // On the path, so a ping URL with a query string keeps it.
      const target = new URL(healthcheck)
      target.pathname = target.pathname.replace(/\/+$/, '') + suffix
      const res = await fetch(target, {
        method: 'POST',
        body: text,
        signal: AbortSignal.timeout(pingTimeoutMs),
      })
      if (!res.ok) log.error(`[cron-trigger] healthcheck ping${suffix} got HTTP ${res.status}`)
    } catch (err) {
      // Only the message: an invalid-URL error carries the URL, which holds the check's key.
      const cause = err?.cause?.message ? ` (${err.cause.message})` : ''
      log.error(`[cron-trigger] healthcheck ping${suffix} failed: ${err?.message ?? err}${cause}`)
    }
  }

  if (!healthcheck) log.log('[cron-trigger] no healthcheck configured (CRON_HEALTHCHECK_URL)')
  await ping('/start')

  log.log(`[cron-trigger] POST ${url}`)

  if (!secret) {
    log.error('[cron-trigger] CRON_SECRET is not set')
    await ping('/fail', 'CRON_SECRET is not set')
    return 1
  }

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${secret}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    const body = redact(await res.text())
    log.log(`[cron-trigger] HTTP ${res.status}`)
    log.log(body)
    const failed = res.ok ? failedJobs(body) : []
    if (failed.length) log.error(`[cron-trigger] jobs failed: ${failed.join(', ')}`)
    const ok = res.ok && failed.length === 0
    const summary = failed.length
      ? `HTTP ${res.status}, jobs failed: ${failed.join(', ')}`
      : `HTTP ${res.status}`
    await ping(ok ? '' : '/fail', `${summary}\n${body}`)
    return ok ? 0 : 1
  } catch (err) {
    log.error('[cron-trigger] request failed:', err)
    await ping('/fail', `request failed: ${err}${err?.cause ? ` (${err.cause})` : ''}`)
    return 1
  }
}

// import.meta.url has symlinks resolved, so resolve argv[1] the same way before comparing.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  process.exit(await run())
}
