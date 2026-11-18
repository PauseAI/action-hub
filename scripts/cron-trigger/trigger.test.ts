import { describe, it, expect } from 'vitest'
import { run } from './trigger.mjs'

const CRON_URL = 'https://hub.test/api/cron/daily'
const HC = 'https://hc-ping.com/0000-uuid'

type Call = { url: string; body: string; auth: string | null }
type Reply = { status: number; body?: string } | Error | 'hang'

/** A fetch that records each request and answers by URL; unlisted URLs get an empty 200. */
function fakeFetch(replies: Record<string, Reply> = {}) {
  const calls: Call[] = []
  const fetch = async (input: string | URL, init: RequestInit = {}) => {
    const url = String(input)
    calls.push({
      url,
      body: typeof init.body === 'string' ? init.body : '',
      auth: new Headers(init.headers).get('authorization'),
    })
    const reply = replies[url] ?? { status: 200 }
    if (reply === 'hang') {
      return new Promise<Response>((_, reject) =>
        init.signal?.addEventListener('abort', () => reject(init.signal?.reason)),
      )
    }
    if (reply instanceof Error) throw reply
    return new Response(reply.body ?? '', { status: reply.status })
  }
  return { fetch: fetch as typeof globalThis.fetch, calls, urls: () => calls.map((c) => c.url) }
}

function fakeLog() {
  const lines: string[] = []
  const write = (...args: unknown[]) => void lines.push(args.map(String).join(' '))
  return { log: { log: write, error: write }, lines }
}

const env = (extra: Record<string, string> = {}) => ({
  CRON_URL,
  CRON_SECRET: 'top-secret',
  CRON_HEALTHCHECK_URL: HC,
  ...extra,
})

describe('cron trigger', () => {
  it('pings start, then success with the status and job results', async () => {
    const f = fakeFetch({ [CRON_URL]: { status: 200, body: '{"digest":{"sent":3}}' } })
    const code = await run({ env: env(), fetch: f.fetch, log: fakeLog().log })
    expect(code).toBe(0)
    expect(f.urls()).toEqual([`${HC}/start`, CRON_URL, HC])
    expect(f.calls[1].auth).toBe('Bearer top-secret')
    expect(f.calls[2].body).toBe('HTTP 200\n{"digest":{"sent":3}}')
  })

  it('pings fail on a non-2xx response and exits 1', async () => {
    const f = fakeFetch({ [CRON_URL]: { status: 500, body: 'boom' } })
    expect(await run({ env: env(), fetch: f.fetch, log: fakeLog().log })).toBe(1)
    expect(f.urls()).toEqual([`${HC}/start`, CRON_URL, `${HC}/fail`])
    expect(f.calls[2].body).toBe('HTTP 500\nboom')
  })

  it('pings fail and exits 1 when a job reports an error in a 200 response', async () => {
    const body = '{"digest":{"sent":3},"backup":{"error":"Error: B2 down"}}'
    const f = fakeFetch({ [CRON_URL]: { status: 200, body } })
    expect(await run({ env: env(), fetch: f.fetch, log: fakeLog().log })).toBe(1)
    expect(f.urls()).toEqual([`${HC}/start`, CRON_URL, `${HC}/fail`])
    expect(f.calls[2].body).toBe(`HTTP 200, jobs failed: backup\n${body}`)
  })

  it('treats a 2xx body that is not a job map as success', async () => {
    for (const body of ['not json', 'null']) {
      const f = fakeFetch({ [CRON_URL]: { status: 200, body } })
      expect(await run({ env: env(), fetch: f.fetch, log: fakeLog().log })).toBe(0)
      expect(f.urls().at(-1)).toBe(HC)
    }
  })

  it('pings fail when the request throws', async () => {
    const f = fakeFetch({ [CRON_URL]: new Error('ECONNREFUSED') })
    expect(await run({ env: env(), fetch: f.fetch, log: fakeLog().log })).toBe(1)
    expect(f.urls().at(-1)).toBe(`${HC}/fail`)
    expect(f.calls.at(-1)?.body).toContain('ECONNREFUSED')
  })

  it('pings fail without calling the app when CRON_SECRET is missing', async () => {
    const f = fakeFetch()
    const code = await run({ env: env({ CRON_SECRET: '' }), fetch: f.fetch, log: fakeLog().log })
    expect(code).toBe(1)
    expect(f.urls()).toEqual([`${HC}/start`, `${HC}/fail`])
    expect(f.calls[1].body).toBe('CRON_SECRET is not set')
  })

  it('trims a long body and never sends or logs the secret', async () => {
    const body = `top-secret ${'x'.repeat(10_000)}`
    const f = fakeFetch({ [CRON_URL]: { status: 200, body } })
    const { log, lines } = fakeLog()
    await run({ env: env(), fetch: f.fetch, log })
    expect(lines.join('\n')).not.toContain('top-secret')
    const sent = f.calls[2].body
    expect(sent).not.toContain('top-secret')
    expect(sent).toContain('[redacted]')
    expect(sent.length).toBeLessThan(4_100)
    expect(sent).toMatch(/…\[truncated\]$/)
  })

  it('strips a trailing slash from the healthcheck URL', async () => {
    const f = fakeFetch()
    await run({ env: env({ CRON_HEALTHCHECK_URL: `${HC}/` }), fetch: f.fetch, log: fakeLog().log })
    expect(f.urls()).toEqual([`${HC}/start`, CRON_URL, HC])
  })

  it('keeps a query string on the healthcheck URL', async () => {
    const f = fakeFetch()
    const hc = 'https://hc-ping.com/key/action-hub-cron?create=1'
    await run({ env: env({ CRON_HEALTHCHECK_URL: hc }), fetch: f.fetch, log: fakeLog().log })
    expect(f.urls()).toEqual([
      'https://hc-ping.com/key/action-hub-cron/start?create=1',
      CRON_URL,
      'https://hc-ping.com/key/action-hub-cron?create=1',
    ])
  })

  it('logs and carries on when the healthcheck URL is invalid', async () => {
    const f = fakeFetch()
    const { log, lines } = fakeLog()
    const code = await run({ env: env({ CRON_HEALTHCHECK_URL: 'not a url' }), fetch: f.fetch, log })
    expect(code).toBe(0)
    expect(f.urls()).toEqual([CRON_URL])
    expect(lines).toContainEqual(expect.stringContaining('ping/start failed'))
  })

  it('carries on when a ping errors or is refused', async () => {
    const f = fakeFetch({ [`${HC}/start`]: new Error('dns'), [HC]: { status: 404 } })
    const { log, lines } = fakeLog()
    expect(await run({ env: env(), fetch: f.fetch, log })).toBe(0)
    expect(f.urls()).toEqual([`${HC}/start`, CRON_URL, HC])
    expect(lines).toContainEqual(expect.stringContaining('ping/start failed'))
    expect(lines).toContainEqual(expect.stringContaining('got HTTP 404'))
  })

  it('gives up on a ping that hangs', async () => {
    const f = fakeFetch({ [`${HC}/start`]: 'hang' })
    const code = await run({ env: env(), fetch: f.fetch, log: fakeLog().log, pingTimeoutMs: 50 })
    expect(code).toBe(0)
    expect(f.urls()).toEqual([`${HC}/start`, CRON_URL, HC])
  })

  it('pings nothing and says so once when no healthcheck is configured', async () => {
    const f = fakeFetch()
    const { log, lines } = fakeLog()
    const code = await run({
      env: { CRON_URL, CRON_SECRET: 'top-secret' },
      fetch: f.fetch,
      log,
    })
    expect(code).toBe(0)
    expect(f.urls()).toEqual([CRON_URL])
    expect(lines.filter((l) => l.includes('no healthcheck configured'))).toHaveLength(1)
  })

  it('defaults to the production URL when CRON_URL is unset or blank', async () => {
    for (const extra of [{}, { CRON_URL: ' ' }]) {
      const f = fakeFetch()
      await run({ env: { CRON_SECRET: 's3', ...extra }, fetch: f.fetch, log: fakeLog().log })
      expect(f.urls()).toEqual(['https://action.pauseai.info/api/cron/daily'])
    }
  })
})
