import { afterEach, describe, it, expect, vi } from 'vitest'
import { HttpLumaClient, lumaClient, lumaIsLive, setLumaClient } from './luma'
import { luma } from '@/test/fakes/luma'

type Sent = { url: string; method: string; headers: Record<string, string>; body: unknown }

/** A fetch that records each request and answers with the next of `replies`. */
function fakeFetch(...replies: Array<{ status?: number; body: unknown }>) {
  const sent: Sent[] = []
  const fetchFn = (async (url: URL, init: RequestInit) => {
    sent.push({
      url: url.toString(),
      method: init.method!,
      headers: init.headers as Record<string, string>,
      body: init.body ? JSON.parse(init.body as string) : undefined,
    })
    const reply = replies.shift()!
    return new Response(JSON.stringify(reply.body), { status: reply.status ?? 200 })
  }) as unknown as typeof fetch
  return { sent, client: new HttpLumaClient('key-1', fetchFn) }
}

const event = {
  name: 'Welcome call',
  startAt: new Date('2026-12-02T14:00:00Z'),
  endAt: new Date('2026-12-02T15:00:00Z'),
  descriptionMd: 'Hello',
  meetingUrl: 'https://meet.google.com/x',
}

describe('HttpLumaClient', () => {
  it('creates an event with the calendar key and the Meet link', async () => {
    const { sent, client } = fakeFetch({ body: { id: 'evt-1' } })
    expect(await client.createEvent(event)).toBe('evt-1')
    expect(sent[0]).toMatchObject({
      url: 'https://public-api.luma.com/v1/events/create',
      method: 'POST',
      headers: { 'x-luma-api-key': 'key-1' },
      body: {
        name: 'Welcome call',
        start_at: '2026-12-02T14:00:00.000Z',
        end_at: '2026-12-02T15:00:00.000Z',
        timezone: 'Etc/UTC',
        description_md: 'Hello',
        meeting_url: 'https://meet.google.com/x',
      },
    })
  })

  it('updates an event by id, leaving out a Meet link it does not have', async () => {
    const { sent, client } = fakeFetch({ body: {} })
    await client.updateEvent('evt-1', { ...event, meetingUrl: null })
    expect(sent[0].url).toBe('https://public-api.luma.com/v1/events/update')
    expect(sent[0].body).toMatchObject({ event_id: 'evt-1' })
    expect(sent[0].body).not.toHaveProperty('meeting_url')
  })

  it('reads an event’s page and approved registrations', async () => {
    const { sent, client } = fakeFetch(
      { body: { url: 'https://luma.com/abc', guest_counts: { approved: { guests: 4 } } } },
      { body: {} },
    )
    expect(await client.getEvent('evt-1')).toEqual({
      url: 'https://luma.com/abc',
      approvedGuests: 4,
    })
    expect(sent[0]).toMatchObject({
      url: 'https://public-api.luma.com/v1/events/get?event_id=evt-1',
      method: 'GET',
      body: undefined,
    })
    expect(await client.getEvent('evt-2')).toEqual({ url: null, approvedGuests: null })
  })

  it('cancels in two steps, with the token the first gives', async () => {
    const { sent, client } = fakeFetch({ body: { cancellation_token: 'tok' } }, { body: {} })
    await client.cancelEvent('evt-1')
    expect(sent.map((s) => [s.url, s.body])).toEqual([
      ['https://public-api.luma.com/v1/events/cancel/request', { event_id: 'evt-1' }],
      [
        'https://public-api.luma.com/v1/events/cancel',
        { event_id: 'evt-1', cancellation_token: 'tok' },
      ],
    ])
  })

  it('adds a host who can manage the event and shows on its page, and removes them', async () => {
    const { sent, client } = fakeFetch({ body: {} }, { body: {} })
    await client.addHost('evt-1', { email: 'kelly@pauseai.info', name: 'Kelly' })
    await client.removeHost('evt-1', 'kelly@pauseai.info')
    expect(sent.map((s) => [s.url, s.body])).toEqual([
      [
        'https://public-api.luma.com/v1/events/hosts/add',
        {
          event_id: 'evt-1',
          email: 'kelly@pauseai.info',
          name: 'Kelly',
          access_level: 'manager',
          is_visible: true,
        },
      ],
      [
        'https://public-api.luma.com/v1/events/hosts/remove',
        { event_id: 'evt-1', email: 'kelly@pauseai.info' },
      ],
    ])
  })

  it('throws Luma’s answer when it refuses', async () => {
    const { client } = fakeFetch({ status: 429, body: { message: 'slow down' } })
    await expect(client.createEvent(event)).rejects.toThrow(
      'Luma /v1/events/create answered 429: {"message":"slow down"}',
    )
  })
})

describe('lumaClient', () => {
  afterEach(() => {
    setLumaClient(luma)
    vi.unstubAllEnvs()
  })

  it('talks to the real calendar only on the live site with a key', () => {
    setLumaClient(undefined)
    vi.stubEnv('LUMA_API_KEY', 'key')
    vi.stubEnv('RAILWAY_ENVIRONMENT_NAME', 'pr-12')
    expect(lumaIsLive()).toBe(false)
    expect(lumaClient()).toBeNull()
    vi.stubEnv('RAILWAY_ENVIRONMENT_NAME', 'production')
    expect(lumaClient()).toBeInstanceOf(HttpLumaClient)
    vi.stubEnv('LUMA_API_KEY', '')
    expect(lumaClient()).toBeNull()
  })

  it('returns the client a test sets', () => {
    expect(setLumaClient(null)).toBe(luma)
    expect(lumaClient()).toBeNull()
  })
})
