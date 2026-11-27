import * as Sentry from '@sentry/nextjs'
import { describe, expect, it } from 'vitest'
import { sentryOptions } from './sentry'

const TOKEN = 'k3Jd9_Xq2LmN8vB4rT6yU1wE5oP0aSdF7gH-zXcVbNm'

/** Captures one exception through a real Sentry client and returns the event it would send. */
async function sentEvent(capture: (scope: Sentry.Scope) => void) {
  const bodies: string[] = []
  const transport = (options: Parameters<typeof Sentry.createTransport>[0]) =>
    Sentry.createTransport(options, async (request) => {
      bodies.push(
        typeof request.body === 'string' ? request.body : new TextDecoder().decode(request.body),
      )
      return { statusCode: 200 }
    })
  const options = sentryOptions({
    dsn: 'https://public@o1.ingest.de.sentry.io/2',
    environment: 'production',
    release: 'abc123',
  })!
  const client = new Sentry.NodeClient({
    ...(options as Sentry.NodeOptions),
    transport,
    stackParser: Sentry.defaultStackParser,
    integrations: [Sentry.requestDataIntegration()],
  })
  const scope = new Sentry.Scope()
  scope.setClient(client)
  client.init()
  capture(scope)
  await client.flush(2000)
  const items = bodies.flatMap((body) => body.split('\n').map((line) => JSON.parse(line)))
  return items.find((item) => item.exception || item.message)
}

describe('Sentry client with sentryOptions', () => {
  it('sends an exception with personal data and credentials scrubbed', async () => {
    const event = await sentEvent((scope) => {
      scope.setSDKProcessingMetadata({
        normalizedRequest: {
          method: 'POST',
          url: `https://action.pauseai.info/api/rpc/auth.login?token=${TOKEN}`,
          query_string: `token=${TOKEN}`,
          headers: {
            'user-agent': 'Mozilla/5.0',
            'x-forwarded-for': '203.0.113.9',
            authorization: `Bearer ${TOKEN}`,
            cookie: `session=${TOKEN}`,
          },
          cookies: { session: TOKEN },
          data: JSON.stringify({ email: 'ada@example.com', password: 'hunter2' }),
        },
      })
      scope.setUser({ id: '4', email: 'ada@example.com', ip_address: '203.0.113.9' })
      scope.setExtra('volunteer', { name: 'Ada Lovelace', email: 'ada@example.com' })
      scope.addBreadcrumb({ category: 'console', message: 'ada@example.com' })
      scope.addBreadcrumb({ category: 'fetch', data: { url: `/api/x?token=${TOKEN}` } })
      scope.captureException(new Error('Could not email ada@example.com'))
    })

    const sent = JSON.stringify(event)
    expect(sent).not.toContain('ada@example.com')
    expect(sent).not.toContain('Ada Lovelace')
    expect(sent).not.toContain(TOKEN)
    expect(sent).not.toContain('hunter2')
    expect(event.user).toBeUndefined()
    expect(event.sdk.settings.infer_ip).toBe('never')
    expect(sent).not.toContain('203.0.113.9')
    expect(event.request).toEqual({
      method: 'POST',
      url: 'https://action.pauseai.info/api/rpc/auth.login',
      headers: { 'User-Agent': 'Mozilla/5.0' },
    })
    expect(event.exception.values[0].value).toBe('Could not email [email]')
    expect(event.extra).toEqual({ volunteer: { name: '[Filtered]', email: '[Filtered]' } })
    expect(event.breadcrumbs).toEqual([
      expect.objectContaining({ category: 'fetch', data: { url: '/api/x' } }),
    ])
    expect(event).toMatchObject({ environment: 'production', release: 'abc123' })
    expect(event.contexts.trace.trace_id).toMatch(/^[0-9a-f]{32}$/)
  })
})
