import { afterEach, beforeEach, describe, it, expect } from 'vitest'
import { prisma } from '@/lib/prisma'
import { setLumaClient } from '@/lib/luma'
import { DEFAULT_LUMA_DESCRIPTION, DEFAULT_LUMA_TITLE } from '@/lib/onboarding'
import { ONBOARDING_SUBJECTS } from '@/lib/onboarding-emails'
import { createOnboardingCall, createOnboardingMember } from '@/test/factories'
import { emails, linkParam } from '@/test/fakes/email'
import { luma } from '@/test/fakes/luma'
import { anon } from '@/test/rpc'
import { runOnboardingCallsJob } from './onboarding-calls'

const DAY = 24 * 60 * 60 * 1000
// The slots are checked against a fixed month; everything else runs from the real now, since
// a reminder's link stops working once its call has started.
const december = new Date('2026-12-01T09:00:00Z')
const now = new Date()
const inDays = (days: number) => new Date(now.getTime() + days * DAY)
const MEET = 'https://meet.google.com/abc-defg-hij'

beforeEach(async () => {
  await prisma.onboardingCall.deleteMany()
  await prisma.onboardingSlot.deleteMany()
  await prisma.onboardingMember.deleteMany()
  await prisma.onboardingSettings.upsert({
    where: { id: 1 },
    create: { id: 1, meetLink: MEET },
    update: { meetLink: MEET },
  })
})

describe('making calls from the regular slots', () => {
  it('makes each slot’s calls for the next four weeks, once', async () => {
    // The fortnight: Call C and Call B in its first week, Call A in its second.
    const slot = (name: string, firstDay: string, time: string) =>
      prisma.onboardingSlot.create({
        data: { name, firstDay: new Date(firstDay), everyWeeks: 2, time },
      })
    await slot('Call C', '2026-12-01', '09:00')
    await slot('Call B', '2026-12-03', '16:00')
    await slot('Call A', '2026-12-09', '14:00')
    expect(await runOnboardingCallsJob(december)).toMatchObject({ made: 5 })
    const calls = await prisma.onboardingCall.findMany({ orderBy: { startsAt: 'asc' } })
    expect(calls.map((c) => [c.name, c.startsAt.toISOString()])).toEqual([
      ['Call B', '2026-12-03T16:00:00.000Z'],
      ['Call A', '2026-12-09T14:00:00.000Z'],
      ['Call C', '2026-12-15T09:00:00.000Z'],
      ['Call B', '2026-12-17T16:00:00.000Z'],
      ['Call A', '2026-12-23T14:00:00.000Z'],
    ])
    expect((await runOnboardingCallsJob(december)).made).toBe(0)
  })

  it('makes no call for a time already past today, nor again on a day whose call was moved', async () => {
    const slot = await prisma.onboardingSlot.create({
      data: { name: 'Call A', firstDay: new Date('2026-12-01'), everyWeeks: 1, time: '08:00' },
    })
    await runOnboardingCallsJob(new Date('2026-12-15T09:00:00Z'))
    const calls = await prisma.onboardingCall.findMany({ orderBy: { startsAt: 'asc' } })
    expect(calls.map((c) => c.startsAt.toISOString())).toEqual([
      '2026-12-22T08:00:00.000Z',
      '2026-12-29T08:00:00.000Z',
      '2027-01-05T08:00:00.000Z',
    ])
    await prisma.onboardingCall.update({
      where: { id: calls[0].id },
      data: { startsAt: new Date('2026-12-22T15:00:00Z') },
    })
    await prisma.onboardingSlot.update({ where: { id: slot.id }, data: { time: '09:00' } })
    expect((await runOnboardingCallsJob(new Date('2026-12-15T09:00:00Z'))).made).toBe(0)
  })
})

describe('reminding hosts', () => {
  it('asks the host four days before, once, with links that need no sign-in', async () => {
    const host = await createOnboardingMember()
    const later = await createOnboardingCall({ hostId: host.id, startsAt: inDays(10) })
    const call = await createOnboardingCall({ hostId: host.id, startsAt: inDays(3) })
    expect(await runOnboardingCallsJob(now)).toMatchObject({ reminded: 1 })
    const email = emails.lastTo(host.email!)
    expect(email.subject).toBe(ONBOARDING_SUBJECTS.reminder(call.startsAt))
    expect(email.html).toContain(MEET)
    expect(email.html).toContain('I need cover')
    expect(linkParam(email, 'token')).toBe(call.actionToken)

    expect((await runOnboardingCallsJob(now)).reminded).toBe(0)
    await anon().onboarding.respond({ token: linkParam(email, 'token'), answer: 'on' })
    const confirmed = await prisma.onboardingCall.findUniqueOrThrow({ where: { id: call.id } })
    expect(confirmed.confirmedAt).not.toBeNull()
    expect(
      (await prisma.onboardingCall.findUniqueOrThrow({ where: { id: later.id } })).remindedAt,
    ).toBeNull()
  })

  it('sends nothing to a host with no address', async () => {
    const host = await createOnboardingMember('MEMBER', { email: null })
    await createOnboardingCall({ hostId: host.id, startsAt: inDays(3) })
    expect(await runOnboardingCallsJob(now)).toMatchObject({ reminded: 0 })
    expect(emails.sent).toHaveLength(0)
  })

  it('carries on when a reminder cannot be sent', async () => {
    const host = await createOnboardingMember()
    await createOnboardingCall({ hostId: host.id, startsAt: inDays(3) })
    emails.failNext()
    expect(await runOnboardingCallsJob(now)).toMatchObject({ reminded: 0 })
  })
})

describe('asking the team for cover', () => {
  it('emails everyone else on the team when the host asks for cover, until someone takes it', async () => {
    const host = await createOnboardingMember('MEMBER', { name: 'Jo Host' })
    const other = await createOnboardingMember()
    const suspended = await createOnboardingMember('MEMBER', { suspendedAt: now })
    const call = await createOnboardingCall({
      hostId: host.id,
      startsAt: inDays(9),
      coverRequestedAt: now,
    })
    expect(await runOnboardingCallsJob(now)).toMatchObject({ asked: 1 })
    expect(emails.to(host.email!)).toHaveLength(0)
    expect(emails.to(suspended.email!)).toHaveLength(0)
    const asked = emails.lastTo(other.email!)
    expect(asked.subject).toBe(ONBOARDING_SUBJECTS.cover(call.startsAt))
    expect(asked.html).toContain('Jo Host can&#x27;t make it and has asked for cover')
    expect((await runOnboardingCallsJob(now)).asked).toBe(0)
  })

  it('asks when a host has not confirmed two days before, and when nobody hosts a close call', async () => {
    const host = await createOnboardingMember('MEMBER', { name: 'Pat Quiet' })
    const other = await createOnboardingMember()
    await createOnboardingCall({ hostId: host.id, startsAt: inDays(1.5), remindedAt: now })
    await createOnboardingCall({ startsAt: inDays(3) })
    await createOnboardingCall({ hostId: host.id, startsAt: inDays(1), confirmedAt: now })
    expect(await runOnboardingCallsJob(now)).toMatchObject({ asked: 2 })
    const html = emails.to(other.email!).map((e) => e.html)
    expect(html.some((h) => h.includes('Pat Quiet hasn&#x27;t said they&#x27;re on yet'))).toBe(
      true,
    )
    expect(html.some((h) => h.includes('Nobody is hosting it yet'))).toBe(true)
  })
})

describe('keeping Luma in step', () => {
  afterEach(() => {
    setLumaClient(luma)
  })

  it('puts each call on Luma with the Meet link, and reads its page and registrations', async () => {
    const call = await createOnboardingCall({ startsAt: inDays(5) })
    expect(await runOnboardingCallsJob(now)).toMatchObject({ created: 1 })
    const [event] = luma.live
    expect(event).toMatchObject({
      name: DEFAULT_LUMA_TITLE,
      descriptionMd: DEFAULT_LUMA_DESCRIPTION,
      startAt: call.startsAt,
      endAt: new Date(call.startsAt.getTime() + 60 * 60 * 1000),
      meetingUrl: MEET,
    })
    luma.setGuests(event.id, 2)
    expect(await runOnboardingCallsJob(now)).toMatchObject({ created: 0, updated: 0 })
    expect(await prisma.onboardingCall.findUniqueOrThrow({ where: { id: call.id } })).toMatchObject(
      { lumaEventId: event.id, lumaUrl: `https://luma.com/${event.id}`, lumaGuests: 2 },
    )
  })

  it('uses the lead’s title and description, and makes the call’s host a host of the event', async () => {
    await prisma.onboardingSettings.update({
      where: { id: 1 },
      data: { lumaTitle: 'Welcome!', lumaDescription: 'Come along' },
    })
    const first = await createOnboardingMember()
    const second = await createOnboardingMember()
    const call = await createOnboardingCall({ startsAt: inDays(5), hostId: first.id })
    await runOnboardingCallsJob(now)
    const [event] = luma.live
    expect(event).toMatchObject({
      name: 'Welcome!',
      descriptionMd: 'Come along',
      hosts: [first.email],
    })
    await prisma.onboardingCall.update({
      where: { id: call.id },
      data: { hostId: second.id, lumaStale: true },
    })
    await runOnboardingCallsJob(now)
    expect(event.hosts).toEqual([second.email])
    await prisma.onboardingCall.update({
      where: { id: call.id },
      data: { hostId: null, lumaStale: true },
    })
    await runOnboardingCallsJob(now)
    expect(event.hosts).toEqual([])
  })

  it('moves an event whose call moved, and cancels one whose call was cancelled', async () => {
    const call = await createOnboardingCall({ startsAt: inDays(5) })
    await runOnboardingCallsJob(now)
    await prisma.onboardingCall.update({
      where: { id: call.id },
      data: { startsAt: inDays(6), lumaStale: true },
    })
    expect(await runOnboardingCallsJob(now)).toMatchObject({ updated: 1 })
    expect(luma.live[0].startAt).toEqual(inDays(6))
    await prisma.onboardingCall.update({
      where: { id: call.id },
      data: { cancelledAt: now, lumaStale: true },
    })
    expect(await runOnboardingCallsJob(now)).toMatchObject({ cancelled: 1 })
    expect(luma.live).toHaveLength(0)
  })

  it('leaves Luma alone for a call cancelled before it got there, and for one too far ahead', async () => {
    await createOnboardingCall({ startsAt: inDays(5), cancelledAt: now })
    await createOnboardingCall({ startsAt: inDays(40) })
    expect(await runOnboardingCallsJob(now)).toMatchObject({ created: 0, cancelled: 0 })
    expect(luma.events.size).toBe(0)
  })

  it('tries again next run when Luma fails, and fails the run so it shows', async () => {
    const call = await createOnboardingCall({ startsAt: inDays(5) })
    luma.failNext()
    await expect(runOnboardingCallsJob(now)).rejects.toThrow(`Luma: call ${call.id}: Luma is down`)
    expect(await runOnboardingCallsJob(now)).toMatchObject({ created: 1 })
    luma.failNext()
    await expect(runOnboardingCallsJob(now)).rejects.toThrow(
      `Luma: guests of call ${call.id}: Luma is down`,
    )
  })

  it('does nothing with Luma where it is off', async () => {
    setLumaClient(null)
    await createOnboardingCall({ startsAt: inDays(5) })
    expect(await runOnboardingCallsJob(now)).toEqual({
      made: 0,
      reminded: 0,
      asked: 0,
      luma: 'off',
    })
  })
})
