import { LumaClient, type LumaEvent, type LumaEventInput } from '@/lib/luma'

type FakeEvent = LumaEventInput & {
  id: string
  guests: number
  cancelled: boolean
  /** Hosts added through the API, by address. */
  hosts: string[]
}

/**
 * Stands in for the Luma calendar: events live in memory. `test/setup-db.ts` installs one per
 * test file and empties it before each test.
 */
export class MemoryLuma extends LumaClient {
  readonly events = new Map<string, FakeEvent>()
  private seq = 0
  private failures = 0

  /** Makes the next `n` requests throw. */
  failNext(n = 1): void {
    this.failures = n
  }

  /** Sets how many people have registered for event `id`. */
  setGuests(id: string, guests: number): void {
    this.get(id).guests = guests
  }

  /** The live (not cancelled) events, oldest first. */
  get live(): FakeEvent[] {
    return [...this.events.values()].filter((e) => !e.cancelled)
  }

  reset(): void {
    this.events.clear()
    this.failures = 0
  }

  private maybeFail() {
    if (this.failures > 0) {
      this.failures--
      throw new Error('Luma is down')
    }
  }

  private get(id: string): FakeEvent {
    const event = this.events.get(id)
    if (!event) throw new Error(`No Luma event ${id}`)
    return event
  }

  async createEvent(event: LumaEventInput): Promise<string> {
    this.maybeFail()
    const id = `evt-${++this.seq}`
    this.events.set(id, { ...event, id, guests: 0, cancelled: false, hosts: [] })
    return id
  }

  async updateEvent(id: string, event: LumaEventInput): Promise<void> {
    this.maybeFail()
    Object.assign(this.get(id), event)
  }

  async getEvent(id: string): Promise<LumaEvent> {
    this.maybeFail()
    const event = this.get(id)
    return { url: `https://luma.com/${id}`, approvedGuests: event.guests }
  }

  async cancelEvent(id: string): Promise<void> {
    this.maybeFail()
    this.get(id).cancelled = true
  }

  async addHost(id: string, host: { email: string }): Promise<void> {
    this.maybeFail()
    this.get(id).hosts.push(host.email)
  }

  async removeHost(id: string, email: string): Promise<void> {
    this.maybeFail()
    const event = this.get(id)
    event.hosts = event.hosts.filter((h) => h !== email)
  }
}

export const luma = new MemoryLuma()
