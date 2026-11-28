import { describe, it, expect } from 'vitest'
import {
  atTime,
  canManageTeam,
  describeSlot,
  formatCallTime,
  hostDueReminder,
  hostMayCancel,
  needsHost,
  respondUrl,
  slotDays,
  slotFallsOn,
  takenIsConfirmed,
  teamShouldBeAsked,
} from './onboarding'

const at = (iso: string) => new Date(iso)
const now = at('2026-12-01T12:00:00Z')
const call = (overrides: Partial<Parameters<typeof teamShouldBeAsked>[0]> = {}) => ({
  startsAt: at('2026-12-10T14:00:00Z'),
  hostId: 1,
  confirmedAt: null,
  coverRequestedAt: null,
  cancelledAt: null,
  ...overrides,
})

describe('slots', () => {
  const slot = { firstDay: at('2026-12-02T00:00:00Z'), everyWeeks: 2, time: '14:00' }

  it('finds the days a slot falls on, from its first day, every few weeks', () => {
    const days = (s: typeof slot, from = now, weeks = 6) =>
      slotDays(s, from, weeks).map((d) => d.toISOString().slice(0, 10))
    expect(days(slot)).toEqual(['2026-12-02', '2026-12-16', '2026-12-30'])
    expect(days({ ...slot, everyWeeks: 1 }, now, 2)).toEqual(['2026-12-02', '2026-12-09'])
    expect(days(slot, at('2026-11-01T00:00:00Z'), 4)).toEqual([])
    expect(slotFallsOn(slot, at('2026-12-16T23:00:00Z'))).toBe(true)
    expect(slotFallsOn(slot, at('2026-12-09T00:00:00Z'))).toBe(false)
  })

  it('puts the time on a day in UTC', () => {
    expect(atTime(at('2026-12-02T00:00:00Z'), '16:30').toISOString()).toBe(
      '2026-12-02T16:30:00.000Z',
    )
  })

  it('describes a slot in words', () => {
    expect(describeSlot(slot)).toBe('Every other Wednesday at 14:00 UTC, from 2 Dec')
    expect(describeSlot({ ...slot, everyWeeks: 1, time: '09:00' })).toBe(
      'Every Wednesday at 09:00 UTC, from 2 Dec',
    )
  })
})

describe('call state', () => {
  it('needs a host when it has none, its host asked for cover, or has not confirmed in time', () => {
    expect(needsHost(call(), now)).toBe(false)
    expect(needsHost(call({ hostId: null }), now)).toBe(true)
    expect(needsHost(call({ coverRequestedAt: now }), now)).toBe(true)
    const tomorrow = at('2026-12-02T12:00:00Z')
    expect(needsHost(call({ startsAt: tomorrow }), now)).toBe(true)
    expect(needsHost(call({ startsAt: tomorrow, confirmedAt: now }), now)).toBe(false)
  })

  it('asks the team for cover, for an unhosted call a few days out, and an unconfirmed one two', () => {
    expect(teamShouldBeAsked(call({ coverRequestedAt: now }), now)).toBe(true)
    expect(teamShouldBeAsked(call({ hostId: null }), now)).toBe(false)
    const inThreeDays = at('2026-12-04T12:00:00Z')
    expect(teamShouldBeAsked(call({ hostId: null, startsAt: inThreeDays }), now)).toBe(true)
    expect(teamShouldBeAsked(call({ startsAt: inThreeDays }), now)).toBe(false)
    const tomorrow = at('2026-12-02T12:00:00Z')
    expect(teamShouldBeAsked(call({ startsAt: tomorrow }), now)).toBe(true)
    expect(teamShouldBeAsked(call({ startsAt: tomorrow, confirmedAt: now }), now)).toBe(false)
    expect(teamShouldBeAsked(call({ coverRequestedAt: now, cancelledAt: now }), now)).toBe(false)
    expect(teamShouldBeAsked(call({ coverRequestedAt: now, startsAt: now }), now)).toBe(false)
  })

  it('reminds an unconfirmed host once, in the last few days', () => {
    const soon = { ...call({ startsAt: at('2026-12-04T12:00:00Z') }), remindedAt: null }
    expect(hostDueReminder(soon, now)).toBe(true)
    expect(hostDueReminder({ ...soon, remindedAt: now }, now)).toBe(false)
    expect(hostDueReminder({ ...soon, confirmedAt: now }, now)).toBe(false)
    expect(hostDueReminder({ ...call(), remindedAt: null }, now)).toBe(false)
  })

  it('lets a host cancel a close call nobody has registered for', () => {
    const close = { ...call({ startsAt: at('2026-12-02T12:00:00Z') }), lumaGuests: 0 }
    expect(hostMayCancel(close, now)).toBe(true)
    expect(hostMayCancel({ ...close, lumaGuests: 2 }, now)).toBe(false)
    expect(hostMayCancel({ ...close, lumaGuests: null }, now)).toBe(false)
    expect(hostMayCancel({ ...call(), lumaGuests: 0 }, now)).toBe(false)
  })

  it('takes a close call as confirmed', () => {
    expect(takenIsConfirmed(at('2026-12-03T12:00:00Z'), now)).toBe(true)
    expect(takenIsConfirmed(at('2026-12-10T12:00:00Z'), now)).toBe(false)
  })
})

describe('wording', () => {
  it('formats a call time in UTC', () => {
    expect(formatCallTime(at('2026-12-02T14:00:00Z'))).toBe('Wed 2 Dec, 14:00 UTC')
  })

  it('builds the reminder links', () => {
    expect(respondUrl('https://hub', 'a b', 'cover')).toBe(
      'https://hub/onboarding/respond?token=a+b&answer=cover',
    )
  })

  it('lets the lead, a deputy and a global admin manage the team', () => {
    expect(canManageTeam('LEAD', false)).toBe(true)
    expect(canManageTeam('DEPUTY', false)).toBe(true)
    expect(canManageTeam('MEMBER', false)).toBe(false)
    expect(canManageTeam(null, true)).toBe(true)
  })
})
