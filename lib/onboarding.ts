/**
 * Global Onboarding: the team that runs welcome calls for new volunteers. Its own section of
 * Action Hub (/onboarding), seen only by its members and global admins. The hourly cron job
 * (jobs/onboarding-calls.ts) makes calls from the regular slots, reminds hosts, asks the team for
 * cover and mirrors every call to the PauseAI Luma calendar (lib/luma.ts).
 */
import type { OnboardingRole } from '@/generated/prisma/enums'

export const ONBOARDING_PATH = '/onboarding'

/** How far ahead the regular slots are turned into calls, and so put on Luma. */
export const WEEKS_AHEAD = 4
/** Every call lasts this long on Luma. */
export const CALL_MINUTES = 60
/** The host is asked "I'm on, or I need cover?" this many days before. */
export const REMIND_DAYS = 4
/** A host who has not said "I'm on" this many days before is covered for by asking the team. */
export const CONFIRM_BY_DAYS = 2
/** From this long before, a host may cancel a call nobody has registered for. */
export const EMPTY_CANCEL_HOURS = 36
/** Luma's registration count is fetched for calls this close. */
export const GUEST_COUNT_DAYS = 7

const DAY_MS = 24 * 60 * 60 * 1000
const HOUR_MS = 60 * 60 * 1000

/** What a Luma event is called and says until the lead sets their own. */
export const DEFAULT_LUMA_TITLE = 'New Member Welcome Session'
export const DEFAULT_LUMA_DESCRIPTION =
  "Welcome to PauseAI Global! This is our community welcome meeting, for all our volunteers (new or re-joining us) to come together, learn about PauseAI and how to get involved, and meet fellow concerned folks. Can't wait to meet you all!"

export const canManageTeam = (role: OnboardingRole | null, globalAdmin: boolean) =>
  globalAdmin || role === 'LEAD' || role === 'DEPUTY'

/** "HH:MM", 00:00 to 23:59. */
export const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/

export function atTime(day: Date, time: string): Date {
  const [h, m] = time.split(':').map(Number)
  return new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), h, m))
}

type Slot = { firstDay: Date; everyWeeks: number; time: string }

const utcDay = (at: Date) => Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate())

/** Whether `slot` falls on the UTC day `day`. */
export function slotFallsOn(slot: Slot, day: Date): boolean {
  const days = Math.round((utcDay(day) - utcDay(slot.firstDay)) / DAY_MS)
  return days >= 0 && days % (slot.everyWeeks * 7) === 0
}

/** The UTC days from `from` (inclusive) for `weeks` weeks on which `slot` falls. */
export function slotDays(slot: Slot, from: Date, weeks = WEEKS_AHEAD): Date[] {
  const start = utcDay(from)
  return Array.from({ length: weeks * 7 }, (_, i) => new Date(start + i * DAY_MS)).filter((day) =>
    slotFallsOn(slot, day),
  )
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const EVERY = ['', 'Every', 'Every other', 'Every third', 'Every fourth']

/** "Every other Wednesday at 14:00 UTC, from 2 Dec". */
export function describeSlot(slot: Slot): string {
  const from = slot.firstDay.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  })
  return `${EVERY[slot.everyWeeks]} ${WEEKDAYS[slot.firstDay.getUTCDay()]} at ${slot.time} UTC, from ${from}`
}

/** "Wed 2 Dec, 14:00 UTC". */
export function formatCallTime(at: Date): string {
  const day = at.toLocaleDateString('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  })
  const time = at.toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'UTC',
  })
  return `${day}, ${time} UTC`
}

type CallState = {
  startsAt: Date
  hostId: number | null
  confirmedAt: Date | null
  coverRequestedAt: Date | null
  cancelledAt: Date | null
}

/**
 * Anyone on the team may take the call: it has no host, its host asked for cover, or its host has
 * not said "I'm on" with CONFIRM_BY_DAYS to go.
 */
export const needsHost = (call: CallState, now: Date) =>
  call.hostId === null ||
  call.coverRequestedAt !== null ||
  (call.confirmedAt === null && call.startsAt.getTime() - now.getTime() <= CONFIRM_BY_DAYS * DAY_MS)

/** Whether the team should be asked to host `call` at `now`. */
export function teamShouldBeAsked(call: CallState, now: Date): boolean {
  if (call.cancelledAt || call.startsAt <= now) return false
  if (call.coverRequestedAt) return true
  const ahead = call.startsAt.getTime() - now.getTime()
  if (call.hostId === null) return ahead <= REMIND_DAYS * DAY_MS
  return ahead <= CONFIRM_BY_DAYS * DAY_MS && call.confirmedAt === null
}

/** Whether `call`'s host should get their reminder at `now`. */
export const hostDueReminder = (call: CallState & { remindedAt: Date | null }, now: Date) =>
  !call.cancelledAt &&
  call.hostId !== null &&
  call.confirmedAt === null &&
  call.coverRequestedAt === null &&
  call.remindedAt === null &&
  call.startsAt > now &&
  call.startsAt.getTime() - now.getTime() <= REMIND_DAYS * DAY_MS

/** A host may cancel their own call once it is close and Luma says nobody has registered. */
export const hostMayCancel = (call: CallState & { lumaGuests: number | null }, now: Date) =>
  call.lumaGuests === 0 &&
  call.startsAt > now &&
  call.startsAt.getTime() - now.getTime() <= EMPTY_CANCEL_HOURS * HOUR_MS

/** Taking a call this close is itself saying "I'm on": no reminder will come. */
export const takenIsConfirmed = (startsAt: Date, now: Date) =>
  startsAt.getTime() - now.getTime() <= REMIND_DAYS * DAY_MS

export const respondUrl = (appUrl: string, token: string, answer: 'on' | 'cover') =>
  `${appUrl}${ONBOARDING_PATH}/respond?${new URLSearchParams({ token, answer })}`
