import { describe, it, expect, afterEach, vi } from 'vitest'
import http from 'node:http'
import {
  HttpSnsGateway,
  SnsGateway,
  isSnsUrl,
  setSnsGateway,
  snsGateway,
  verifySnsMessage,
} from './sns'
import { TOPIC_ARN, sns } from '@/test/fakes/sns'

afterEach(() => {
  vi.unstubAllEnvs()
  setSnsGateway(sns)
})

/** Serves `routes` (path to status and body) and records the paths requested. */
async function serve(routes: Record<string, [number, string]>) {
  const requested: string[] = []
  const server = http.createServer((req, res) => {
    requested.push(req.url ?? '')
    const [status, body] = routes[req.url ?? ''] ?? [404, '']
    res.writeHead(status)
    res.end(body)
  })
  await new Promise<void>((resolve) => server.listen(0, resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('server has no port')
  return {
    url: (path: string) => `http://127.0.0.1:${address.port}${path}`,
    requested,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

describe('HttpSnsGateway', () => {
  it('fetches a certificate once and serves it from cache after', async () => {
    const server = await serve({ '/cert.pem': [200, 'PEM'], '/missing.pem': [404, ''] })
    try {
      const gateway = new HttpSnsGateway()
      expect(await gateway.certificate(server.url('/cert.pem'))).toBe('PEM')
      expect(await gateway.certificate(server.url('/cert.pem'))).toBe('PEM')
      expect(server.requested).toEqual(['/cert.pem'])
      await expect(gateway.certificate(server.url('/missing.pem'))).rejects.toThrow('404')
    } finally {
      await server.close()
    }
  })

  it('keeps the cache small by starting over once it is full', async () => {
    const routes = Object.fromEntries(
      Array.from({ length: 21 }, (_, n) => [`/${n}.pem`, [200, `PEM${n}`] as [number, string]]),
    )
    const server = await serve(routes)
    try {
      const gateway = new HttpSnsGateway()
      for (let n = 0; n < 21; n++) await gateway.certificate(server.url(`/${n}.pem`))
      await gateway.certificate(server.url('/0.pem'))
      expect(server.requested.filter((path) => path === '/0.pem')).toHaveLength(2)
    } finally {
      await server.close()
    }
  })

  it('confirms a subscription by visiting its URL, and reports a refusal', async () => {
    const server = await serve({ '/confirm': [200, '<xml/>'], '/refused': [403, ''] })
    try {
      const gateway = new HttpSnsGateway()
      await gateway.confirm(server.url('/confirm'))
      expect(server.requested).toEqual(['/confirm'])
      await expect(gateway.confirm(server.url('/refused'))).rejects.toThrow('403')
    } finally {
      await server.close()
    }
  })

  it('is the process-wide gateway unless one is swapped in', () => {
    expect(setSnsGateway(undefined)).toBe(sns)
    const fromDefault = snsGateway()
    expect(fromDefault).toBeInstanceOf(HttpSnsGateway)
    expect(snsGateway()).toBe(fromDefault)
  })
})

describe('isSnsUrl', () => {
  it('accepts only https on an SNS host, including China regions', () => {
    expect(isSnsUrl('https://sns.us-east-1.amazonaws.com/x.pem', /\.pem$/)).toBe(true)
    expect(isSnsUrl('https://sns.cn-north-1.amazonaws.com.cn/x')).toBe(true)
    expect(isSnsUrl('https://sns.amazonaws.com/x')).toBe(false)
    expect(isSnsUrl('https://xsns.us-east-1.amazonaws.com/x')).toBe(false)
    expect(isSnsUrl(undefined)).toBe(false)
  })
})

describe('verifySnsMessage', () => {
  it('leaves a null field out of what was signed, as SNS does', async () => {
    vi.stubEnv('SES_FEEDBACK_TOPIC_ARN', TOPIC_ARN)
    const signed = sns.notification({})
    const withNull = { ...signed, Subject: null } as unknown as typeof signed
    expect(await verifySnsMessage(withNull)).toEqual({ ok: true })
  })

  it('refuses a message when the certificate it was given is not a key', async () => {
    vi.stubEnv('SES_FEEDBACK_TOPIC_ARN', TOPIC_ARN)
    class Garbage extends SnsGateway {
      async certificate(): Promise<string> {
        return 'not a certificate'
      }
      async confirm(): Promise<void> {}
    }
    setSnsGateway(new Garbage())
    expect(await verifySnsMessage(sns.notification({}))).toEqual({
      ok: false,
      reason: 'bad signature',
    })
  })
})
