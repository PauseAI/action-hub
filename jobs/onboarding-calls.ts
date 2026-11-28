import { prisma } from '@/lib/prisma'
import { lumaClient, type LumaClient } from '@/lib/luma'
import {
  CALL_MINUTES,
  GUEST_COUNT_DAYS,
  DEFAULT_LUMA_DESCRIPTION,
  DEFAULT_LUMA_TITLE,
  REMIND_DAYS,
  WEEKS_AHEAD,
  atTime,
  hostDueReminder,
  slotDays,
  teamShouldBeAsked,
} from '@/lib/onboarding'
import { coverEmail, reminderEmail, type CoverReason } from '@/lib/onboarding-emails'
import {
  emailMember,
  freshHost,
  newActionToken,
  onboardingSettings,
  reachableTeam,
} from '@/lib/onboarding-server'

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Takes the host off each coming call whose host has left the team or whose account is suspended
 * or deleted, so the call needs a host again and their reminder link stops working.
 */
async function freeLostHosts(now: Date): Promise<number> {
  const calls = await prisma.onboardingCall.findMany({
    where: {
      cancelledAt: null,
      startsAt: { gt: now },
      host: {
        OR: [
          { deletedAt: { not: null } },
          { suspendedAt: { not: null } },
          { onboardingMember: null },
        ],
      },
    },
    select: { id: true },
  })
  for (const call of calls) {
    await prisma.onboardingCall.update({ where: { id: call.id }, data: freshHost(null) })
  }
  return calls.length
}

/** Makes a call for each day a regular slot falls on, up to WEEKS_AHEAD; never twice a day. */
export async function makeCallsFromSlots(now: Date): Promise<number> {
  const slots = await prisma.onboardingSlot.findMany()
  const data = slots.flatMap((slot) =>
    slotDays(slot, now)
      .map((day) => ({ day, startsAt: atTime(day, slot.time) }))
      .filter(({ startsAt }) => startsAt > now)
      .map(({ day, startsAt }) => ({
        name: slot.name,
        startsAt,
        slotId: slot.id,
        slotDay: day,
        actionToken: newActionToken(),
      })),
  )
  if (data.length === 0) return 0
  const { count } = await prisma.onboardingCall.createMany({ data, skipDuplicates: true })
  return count
}

const upcoming = (now: Date, days: number) => ({
  cancelledAt: null,
  startsAt: { gt: now, lte: new Date(now.getTime() + days * DAY_MS) },
})

/** Asks each host due a reminder whether they're on. Claimed first, so it goes once. */
async function remindHosts(now: Date, link: string | null): Promise<number> {
  const calls = await prisma.onboardingCall.findMany({
    where: { ...upcoming(now, REMIND_DAYS), hostId: { not: null }, remindedAt: null },
    include: { host: true },
  })
  let sent = 0
  for (const call of calls.filter((c) => hostDueReminder(c, now))) {
    const { count } = await prisma.onboardingCall.updateMany({
      where: { id: call.id, remindedAt: null, hostId: call.hostId },
      data: { remindedAt: now },
    })
    if (count === 1 && (await emailMember(call.host!, reminderEmail(call, link)))) sent++
  }
  return sent
}

/** Asks the rest of the team to host each call that needs it, once until someone takes it. */
async function askTeam(now: Date): Promise<number> {
  const calls = await prisma.onboardingCall.findMany({
    where: { cancelledAt: null, startsAt: { gt: now }, teamAskedAt: null },
    include: { host: { select: { name: true } } },
  })
  let asked = 0
  for (const call of calls.filter((c) => teamShouldBeAsked(c, now))) {
    const { count } = await prisma.onboardingCall.updateMany({
      where: { id: call.id, teamAskedAt: null },
      data: { teamAskedAt: now },
    })
    if (count === 0) continue
    const reason: CoverReason = !call.host
      ? { kind: 'none' }
      : { kind: call.coverRequestedAt ? 'cover' : 'unconfirmed', hostName: call.host.name }
    for (const member of await reachableTeam(call.hostId)) {
      await emailMember(member, coverEmail(call, reason))
    }
    asked++
  }
  return asked
}

type LumaTally = { created: number; updated: number; cancelled: number; errors: string[] }

type Settings = Awaited<ReturnType<typeof onboardingSettings>>

/** Makes the event's API-added host the call's host, by their Action Hub address. */
async function syncHost(
  client: LumaClient,
  eventId: string,
  call: {
    id: number
    lumaHostEmail: string | null
    host: { name: string; email: string | null } | null
  },
) {
  const email = call.host?.email ?? null
  if (email === call.lumaHostEmail) return
  if (call.lumaHostEmail) {
    await client.removeHost(eventId, call.lumaHostEmail)
    await prisma.onboardingCall.update({ where: { id: call.id }, data: { lumaHostEmail: null } })
  }
  if (email) {
    await client.addHost(eventId, { email, name: call.host!.name })
    await prisma.onboardingCall.update({ where: { id: call.id }, data: { lumaHostEmail: email } })
  }
}

/**
 * Sends Luma each call it is out of date on, up to WEEKS_AHEAD. The stale mark is cleared before
 * Luma is called, so an edit made meanwhile marks it again for the next run.
 */
async function pushToLuma(now: Date, client: LumaClient, settings: Settings): Promise<LumaTally> {
  const tally: LumaTally = { created: 0, updated: 0, cancelled: 0, errors: [] }
  const calls = await prisma.onboardingCall.findMany({
    where: {
      lumaStale: true,
      startsAt: { gt: now, lte: new Date(now.getTime() + WEEKS_AHEAD * 7 * DAY_MS) },
    },
    include: { host: { select: { name: true, email: true } } },
    orderBy: { startsAt: 'asc' },
  })
  for (const call of calls) {
    await prisma.onboardingCall.update({ where: { id: call.id }, data: { lumaStale: false } })
    try {
      if (call.cancelledAt) {
        if (call.lumaEventId) {
          await client.cancelEvent(call.lumaEventId)
          // Luma has deleted it, so there is nothing left to send.
          await prisma.onboardingCall.update({
            where: { id: call.id },
            data: { lumaEventId: null },
          })
          tally.cancelled++
        }
        continue
      }
      const event = {
        name: settings.lumaTitle ?? DEFAULT_LUMA_TITLE,
        startAt: call.startsAt,
        endAt: new Date(call.startsAt.getTime() + CALL_MINUTES * 60 * 1000),
        descriptionMd: settings.lumaDescription ?? DEFAULT_LUMA_DESCRIPTION,
        meetingUrl: settings.meetLink,
      }
      let eventId = call.lumaEventId
      if (eventId) {
        await client.updateEvent(eventId, event)
        tally.updated++
      } else {
        eventId = await client.createEvent(event)
        await prisma.onboardingCall.update({
          where: { id: call.id },
          data: { lumaEventId: eventId },
        })
        tally.created++
      }
      if (!call.lumaUrl) {
        const { url } = await client.getEvent(eventId)
        await prisma.onboardingCall.update({ where: { id: call.id }, data: { lumaUrl: url } })
      }
      await syncHost(client, eventId, call)
    } catch (err) {
      await prisma.onboardingCall.update({ where: { id: call.id }, data: { lumaStale: true } })
      tally.errors.push(`call ${call.id}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  return tally
}

/** Reads how many have registered for each call in the next GUEST_COUNT_DAYS, and its page. */
async function readGuests(now: Date, client: LumaClient, errors: string[]): Promise<void> {
  const calls = await prisma.onboardingCall.findMany({
    where: { ...upcoming(now, GUEST_COUNT_DAYS), lumaEventId: { not: null } },
    select: { id: true, lumaEventId: true },
  })
  for (const call of calls) {
    try {
      const { url, approvedGuests } = await client.getEvent(call.lumaEventId!)
      await prisma.onboardingCall.update({
        where: { id: call.id },
        data: { lumaGuests: approvedGuests, ...(url && { lumaUrl: url }) },
      })
    } catch (err) {
      errors.push(`guests of call ${call.id}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
}

/**
 * Global Onboarding's hourly run (lib/onboarding.ts): makes calls from the regular slots, reminds
 * hosts, asks the team for cover and keeps Luma in step. A Luma failure is retried next hour, and
 * fails the run once everything else is done, so the cron healthcheck shows it.
 */
export async function runOnboardingCallsJob(now: Date = new Date()) {
  const freed = await freeLostHosts(now)
  const made = await makeCallsFromSlots(now)
  const settings = await onboardingSettings()
  const reminded = await remindHosts(now, settings.meetLink)
  const asked = await askTeam(now)
  const client = lumaClient()
  if (!client) return { freed, made, reminded, asked, luma: 'off' as const }
  const tally = await pushToLuma(now, client, settings)
  await readGuests(now, client, tally.errors)
  if (tally.errors.length > 0) throw new Error(`Luma: ${tally.errors.join('; ')}`)
  const { created, updated, cancelled } = tally
  return { freed, made, reminded, asked, created, updated, cancelled }
}
