import { env } from './env'

/** What Action Hub puts on a Luma event. Luma's own fields are named in HttpLumaClient. */
export type LumaEventInput = {
  name: string
  startAt: Date
  endAt: Date
  descriptionMd: string
  meetingUrl: string | null
}

export type LumaEvent = { url: string | null; approvedGuests: number | null }

/**
 * The PauseAI Luma calendar, which the onboarding cron job (jobs/onboarding-calls.ts) keeps in
 * step with Action Hub. `lumaClient()` returns whichever client is in force; tests swap in
 * `MemoryLuma` (test/fakes/luma.ts) with `setLumaClient`.
 */
export abstract class LumaClient {
  /** Returns the new event's id. */
  abstract createEvent(event: LumaEventInput): Promise<string>
  abstract updateEvent(id: string, event: LumaEventInput): Promise<void>
  abstract getEvent(id: string): Promise<LumaEvent>
  /** Deletes the event; Luma tells anyone registered. */
  abstract cancelEvent(id: string): Promise<void>
  /** Shows `email` as a host on the event page, able to manage the event. */
  abstract addHost(id: string, host: { email: string; name: string }): Promise<void>
  abstract removeHost(id: string, email: string): Promise<void>
}

const BASE_URL = 'https://public-api.luma.com'

type Fetch = typeof fetch

/** Luma's public API (docs.luma.com/reference), with a key scoped to the one calendar. */
export class HttpLumaClient extends LumaClient {
  constructor(
    private readonly apiKey: string,
    private readonly fetchFn: Fetch = fetch,
  ) {
    super()
  }

  private async call<T>(method: 'GET' | 'POST', path: string, body: object): Promise<T> {
    const url = new URL(path, BASE_URL)
    if (method === 'GET') {
      for (const [k, v] of Object.entries(body)) url.searchParams.set(k, String(v))
    }
    const response = await this.fetchFn(url, {
      method,
      headers: { 'x-luma-api-key': this.apiKey, 'content-type': 'application/json' },
      body: method === 'POST' ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20_000),
    })
    if (!response.ok) {
      const text = (await response.text()).slice(0, 300)
      throw new Error(`Luma ${path} answered ${response.status}: ${text}`)
    }
    return (await response.json()) as T
  }

  private fields(event: LumaEventInput) {
    return {
      name: event.name,
      start_at: event.startAt.toISOString(),
      end_at: event.endAt.toISOString(),
      timezone: 'Etc/UTC',
      description_md: event.descriptionMd,
      ...(event.meetingUrl && { meeting_url: event.meetingUrl }),
    }
  }

  async createEvent(event: LumaEventInput): Promise<string> {
    const { id } = await this.call<{ id: string }>('POST', '/v1/events/create', this.fields(event))
    return id
  }

  async updateEvent(id: string, event: LumaEventInput): Promise<void> {
    await this.call('POST', '/v1/events/update', { event_id: id, ...this.fields(event) })
  }

  async getEvent(id: string): Promise<LumaEvent> {
    const event = await this.call<{
      url?: string
      guest_counts?: { approved?: { guests?: number } }
    }>('GET', '/v1/events/get', { event_id: id })
    return {
      url: event.url ?? null,
      approvedGuests: event.guest_counts?.approved?.guests ?? null,
    }
  }

  async cancelEvent(id: string): Promise<void> {
    const { cancellation_token } = await this.call<{ cancellation_token: string }>(
      'POST',
      '/v1/events/cancel/request',
      { event_id: id },
    )
    await this.call('POST', '/v1/events/cancel', { event_id: id, cancellation_token })
  }

  async addHost(id: string, host: { email: string; name: string }): Promise<void> {
    await this.call('POST', '/v1/events/hosts/add', {
      event_id: id,
      email: host.email,
      name: host.name,
      access_level: 'manager',
      is_visible: true,
    })
  }

  async removeHost(id: string, email: string): Promise<void> {
    await this.call('POST', '/v1/events/hosts/remove', { event_id: id, email })
  }
}

/**
 * Only the live site writes to the real calendar: a key copied into a preview environment, or
 * a developer's checkout, leaves Luma alone.
 */
export const lumaIsLive = () =>
  Boolean(env.LUMA_API_KEY) && env.RAILWAY_ENVIRONMENT_NAME === 'production'

let current: LumaClient | null | undefined

/** The client in force, or null when Action Hub does not talk to Luma here. */
export function lumaClient(): LumaClient | null {
  if (current !== undefined) return current
  return lumaIsLive() ? new HttpLumaClient(env.LUMA_API_KEY!) : null
}

/** Replaces the client (null: no Luma); `undefined` restores the default. Returns the previous. */
export function setLumaClient(
  client: LumaClient | null | undefined,
): LumaClient | null | undefined {
  const previous = current
  current = client
  return previous
}
