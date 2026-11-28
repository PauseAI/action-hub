import { z } from 'zod'
import { ORPCError } from '@orpc/server'
import { prisma } from '@/lib/prisma'
import { lumaIsLive } from '@/lib/luma'
import {
  TIME_PATTERN,
  atTime,
  canManageTeam,
  hostMayCancel,
  needsHost,
  slotFallsOn,
  takenIsConfirmed,
} from '@/lib/onboarding'
import { assignedEmail, swappedEmail } from '@/lib/onboarding-emails'
import {
  ELIGIBLE,
  emailMember,
  freshHost,
  meetLink,
  newActionToken,
  onboardingSettings,
} from '@/lib/onboarding-server'
import { makeCallsFromSlots } from '@/jobs/onboarding-calls'
import { OnboardingRole } from '@/generated/prisma/enums'
import { adminProcedure, authedProcedure, publicProcedure } from '../procedures'

const callId = z.object({ callId: z.number().int() })
const name = z.string().trim().min(1).max(100)
const future = z.date()

/** A team member, or a global admin, who sees everything a lead does. */
const memberProcedure = authedProcedure.use(async ({ context, next }) => {
  const member = await prisma.onboardingMember.findUnique({
    where: { volunteerId: context.volunteer.id },
    select: { role: true },
  })
  const globalAdmin = context.access.globalAdmin
  if (!member && !globalAdmin) throw new ORPCError('FORBIDDEN')
  const role = member?.role ?? null
  return next({ context: { role, manages: canManageTeam(role, globalAdmin) } })
})

/** The lead, a deputy, or a global admin. */
const managerProcedure = memberProcedure.use(({ context, next }) => {
  if (!context.manages) throw new ORPCError('FORBIDDEN')
  return next()
})

async function upcomingCall(id: number, now = new Date()) {
  const call = await prisma.onboardingCall.findUnique({ where: { id } })
  if (!call || call.cancelledAt || call.startsAt <= now) {
    throw new ORPCError('NOT_FOUND', { message: 'That call has passed or was cancelled' })
  }
  return call
}

async function isMember(volunteerId: number) {
  return Boolean(await prisma.onboardingMember.findUnique({ where: { volunteerId } }))
}

const notHost = () => new ORPCError('FORBIDDEN', { message: 'Only its host can do that' })

/** The host's "I'm on", which also takes back a request for cover. */
async function confirm(id: number) {
  await prisma.onboardingCall.update({
    where: { id },
    data: { confirmedAt: new Date(), coverRequestedAt: null, teamAskedAt: null },
  })
}

/** The team is asked by the next hourly run. */
async function requestCover(id: number) {
  await prisma.onboardingCall.update({
    where: { id },
    data: { coverRequestedAt: new Date(), confirmedAt: null, teamAskedAt: null },
  })
}

async function liveCallByToken(token: string) {
  const call = await prisma.onboardingCall.findUnique({
    where: { actionToken: token },
    include: { host: { select: { name: true } } },
  })
  if (!call || !call.host || call.cancelledAt || call.startsAt <= new Date()) {
    throw new ORPCError('NOT_FOUND', {
      message: 'This link no longer works: the call has passed, was cancelled or has a new host',
    })
  }
  return call
}

export const onboardingRouter = {
  /** Everything the section shows: calls from an hour ago on, the team and the regular slots. */
  overview: memberProcedure.handler(async ({ context }) => {
    const since = new Date(Date.now() - 60 * 60 * 1000)
    const [calls, members, slots, settings] = await Promise.all([
      prisma.onboardingCall.findMany({
        where: { startsAt: { gte: since } },
        orderBy: { startsAt: 'asc' },
        take: 40,
        include: { host: { select: { id: true, name: true } } },
      }),
      prisma.onboardingMember.findMany({
        where: { volunteer: { deletedAt: null } },
        orderBy: [{ role: 'asc' }, { createdAt: 'asc' }],
        select: { role: true, volunteer: { select: { id: true, name: true } } },
      }),
      prisma.onboardingSlot.findMany({ orderBy: [{ time: 'asc' }, { createdAt: 'asc' }] }),
      onboardingSettings(),
    ])
    const now = new Date()
    return {
      me: context.volunteer.id,
      role: context.role,
      manages: context.manages,
      isAdmin: context.access.globalAdmin,
      settings,
      lumaLive: lumaIsLive(),
      calls: calls.map((c) => ({
        id: c.id,
        name: c.name,
        startsAt: c.startsAt,
        host: c.host,
        confirmed: c.confirmedAt !== null,
        coverRequested: c.coverRequestedAt !== null,
        cancelled: c.cancelledAt !== null,
        lumaUrl: c.lumaUrl,
        lumaGuests: c.lumaGuests,
        hostMayCancel: hostMayCancel(c, now),
        takeable: needsHost(c, now),
      })),
      members: members.map((m) => ({ ...m.volunteer, role: m.role })),
      slots: slots.map((s) => ({
        id: s.id,
        name: s.name,
        firstDay: s.firstDay,
        everyWeeks: s.everyWeeks,
        time: s.time,
      })),
    }
  }),

  /** "I'll host": a call with no host, or whose host asked for cover. */
  take: memberProcedure.input(callId).handler(async ({ input, context }) => {
    if (!context.role) throw new ORPCError('FORBIDDEN', { message: 'Only the team hosts calls' })
    const call = await upcomingCall(input.callId)
    if (!needsHost(call, new Date()) || call.hostId === context.volunteer.id) {
      throw new ORPCError('CONFLICT', { message: 'Someone is already hosting that call' })
    }
    const confirmedAt = takenIsConfirmed(call.startsAt, new Date()) ? new Date() : null
    const { count } = await prisma.onboardingCall.updateMany({
      where: {
        id: call.id,
        hostId: call.hostId,
        coverRequestedAt: call.coverRequestedAt,
        confirmedAt: call.confirmedAt,
      },
      data: freshHost(context.volunteer.id, confirmedAt),
    })
    if (count === 0) throw new ORPCError('CONFLICT', { message: 'Someone else just took it' })
    return { message: "You're hosting it" }
  }),

  confirm: memberProcedure.input(callId).handler(async ({ input, context }) => {
    const call = await upcomingCall(input.callId)
    if (call.hostId !== context.volunteer.id) throw notHost()
    await confirm(call.id)
    return { message: "Thanks, you're on" }
  }),

  requestCover: memberProcedure.input(callId).handler(async ({ input, context }) => {
    const call = await upcomingCall(input.callId)
    if (call.hostId !== context.volunteer.id && !context.manages) throw notHost()
    if (!call.hostId) throw new ORPCError('BAD_REQUEST', { message: 'Nobody is hosting it yet' })
    await requestCover(call.id)
    return { message: 'The rest of the team will be asked to cover it within the hour' }
  }),

  /** Swaps hosts with another member's call; that member is told. */
  swap: memberProcedure
    .input(z.object({ callId: z.number().int(), withCallId: z.number().int() }))
    .handler(async ({ input, context }) => {
      const mine = await upcomingCall(input.callId)
      const theirs = await upcomingCall(input.withCallId)
      if (mine.hostId !== context.volunteer.id) throw notHost()
      if (!theirs.hostId || theirs.hostId === context.volunteer.id) {
        throw new ORPCError('BAD_REQUEST', { message: 'Pick a call someone else is hosting' })
      }
      const other = theirs.hostId
      await prisma.$transaction(async (tx) => {
        const a = await tx.onboardingCall.updateMany({
          where: { id: mine.id, hostId: mine.hostId },
          data: freshHost(other),
        })
        const b = await tx.onboardingCall.updateMany({
          where: { id: theirs.id, hostId: other },
          data: freshHost(context.volunteer.id),
        })
        if (a.count + b.count !== 2) {
          throw new ORPCError('CONFLICT', { message: 'One of those calls just changed' })
        }
      })
      const them = await prisma.volunteer.findUniqueOrThrow({ where: { id: other } })
      await emailMember(them, swappedEmail(context.volunteer.name, mine.startsAt, theirs.startsAt))
      return { message: `Swapped with ${them.name}` }
    }),

  /** Changes a call's time, such as to the host's usual time; Luma follows. */
  setTime: memberProcedure
    .input(z.object({ callId: z.number().int(), startsAt: future }))
    .handler(async ({ input, context }) => {
      const call = await upcomingCall(input.callId)
      if (call.hostId !== context.volunteer.id && !context.manages) throw notHost()
      if (input.startsAt <= new Date()) {
        throw new ORPCError('BAD_REQUEST', { message: 'Pick a time in the future' })
      }
      await prisma.onboardingCall.update({
        where: { id: call.id },
        data: {
          startsAt: input.startsAt,
          lumaStale: true,
          remindedAt: null,
          teamAskedAt: null,
          // A host whose call someone else moved is asked again.
          ...(call.hostId !== context.volunteer.id && { confirmedAt: null }),
        },
      })
      return { message: 'Time changed' }
    }),

  /** The lead's, or a deputy's; a host may cancel a call nobody has registered for. */
  cancel: memberProcedure.input(callId).handler(async ({ input, context }) => {
    const call = await upcomingCall(input.callId)
    const own = call.hostId === context.volunteer.id && hostMayCancel(call, new Date())
    if (!context.manages && !own) throw new ORPCError('FORBIDDEN')
    await prisma.onboardingCall.update({
      where: { id: call.id },
      data: { cancelledAt: new Date(), lumaStale: true },
    })
    return { message: 'Call cancelled' }
  }),

  add: managerProcedure.input(z.object({ name, startsAt: future })).handler(async ({ input }) => {
    if (input.startsAt <= new Date()) {
      throw new ORPCError('BAD_REQUEST', { message: 'Pick a time in the future' })
    }
    await prisma.onboardingCall.create({
      data: { name: input.name, startsAt: input.startsAt, actionToken: newActionToken() },
    })
    return { message: 'Call added' }
  }),

  /** Puts a member down to host a call, or nobody; the new host is told. */
  assign: managerProcedure
    .input(z.object({ callId: z.number().int(), hostId: z.number().int().nullable() }))
    .handler(async ({ input, context }) => {
      const call = await upcomingCall(input.callId)
      if (input.hostId !== null && !(await isMember(input.hostId))) {
        throw new ORPCError('BAD_REQUEST', { message: 'Only a team member can host' })
      }
      if (input.hostId === call.hostId) return { message: 'No change' }
      const updated = await prisma.onboardingCall.update({
        where: { id: call.id },
        data: freshHost(input.hostId),
        include: { host: true },
      })
      if (updated.host && updated.host.id !== context.volunteer.id) {
        await emailMember(
          updated.host,
          assignedEmail(context.volunteer.name, updated, await meetLink()),
        )
      }
      return {
        message: updated.host ? `${updated.host.name} is hosting it` : 'Nobody is hosting it',
      }
    }),

  /**
   * Adds a regular call, or changes one. A change moves, or drops, its coming calls that nobody
   * hosts yet; a hosted call keeps its time, which its host may have chosen.
   */
  saveSlot: managerProcedure
    .input(
      z.object({
        slotId: z.number().int().optional(),
        name,
        firstDay: z.date(),
        everyWeeks: z.number().int().min(1).max(4),
        time: z.string().regex(TIME_PATTERN, 'Give the time as HH:MM'),
      }),
    )
    .handler(async ({ input }) => {
      const { slotId, ...data } = input
      const now = new Date()
      if (slotId === undefined) {
        await prisma.onboardingSlot.create({ data })
      } else {
        const slot = await prisma.onboardingSlot.update({ where: { id: slotId }, data })
        const open = await prisma.onboardingCall.findMany({
          where: { slotId, hostId: null, cancelledAt: null, startsAt: { gt: now } },
        })
        for (const call of open) {
          const day = call.slotDay!
          const startsAt = atTime(day, slot.time)
          if (slotFallsOn(slot, day) && startsAt > now) {
            await prisma.onboardingCall.update({
              where: { id: call.id },
              data: { name: slot.name, startsAt, lumaStale: true },
            })
          } else if (call.lumaEventId) {
            await prisma.onboardingCall.update({
              where: { id: call.id },
              data: { cancelledAt: now, lumaStale: true },
            })
          } else {
            await prisma.onboardingCall.delete({ where: { id: call.id } })
          }
        }
      }
      await makeCallsFromSlots(now)
      return { message: slotId === undefined ? 'Regular call added' : 'Regular call saved' }
    }),

  /** Stops making calls from it; the calls already made stay. */
  removeSlot: managerProcedure
    .input(z.object({ slotId: z.number().int() }))
    .handler(async ({ input }) => {
      const { count } = await prisma.onboardingSlot.deleteMany({ where: { id: input.slotId } })
      if (!count) throw new ORPCError('NOT_FOUND')
      return { message: 'Regular call removed' }
    }),

  /** The Meet link and what each Luma event says; every coming event is updated. */
  saveSettings: managerProcedure
    .input(
      z.object({
        meetLink: z
          .url({ protocol: /^https$/ })
          .max(300)
          .nullable(),
        lumaTitle: z.string().trim().max(200).nullable(),
        lumaDescription: z.string().trim().max(5000).nullable(),
      }),
    )
    .handler(async ({ input }) => {
      const data = {
        meetLink: input.meetLink,
        lumaTitle: input.lumaTitle || null,
        lumaDescription: input.lumaDescription || null,
      }
      await prisma.$transaction([
        prisma.onboardingSettings.upsert({
          where: { id: 1 },
          create: { id: 1, ...data },
          update: data,
        }),
        prisma.onboardingCall.updateMany({
          where: { startsAt: { gt: new Date() }, cancelledAt: null },
          data: { lumaStale: true },
        }),
      ])
      return { message: 'Saved; Luma is updated within the hour' }
    }),

  /** Adds someone by their Action Hub address, which keeps the directory out of it. */
  addMember: managerProcedure.input(z.object({ email: z.email() })).handler(async ({ input }) => {
    const volunteer = await prisma.volunteer.findFirst({
      where: { ...ELIGIBLE, email: { equals: input.email.trim(), mode: 'insensitive' } },
      select: { id: true, name: true },
    })
    if (!volunteer) {
      throw new ORPCError('NOT_FOUND', {
        message: 'No approved Action Hub account has that address',
      })
    }
    await prisma.onboardingMember.upsert({
      where: { volunteerId: volunteer.id },
      create: { volunteerId: volunteer.id },
      update: {},
    })
    return { message: `${volunteer.name} is on the team` }
  }),

  /** Takes someone off the team and off the calls they were hosting, which then need a host. */
  removeMember: managerProcedure
    .input(z.object({ volunteerId: z.number().int() }))
    .handler(async ({ input, context }) => {
      const member = await prisma.onboardingMember.findUnique({
        where: { volunteerId: input.volunteerId },
      })
      if (!member) throw new ORPCError('NOT_FOUND')
      const outranks =
        context.access.globalAdmin ||
        (context.role === 'LEAD' && member.role !== 'LEAD') ||
        member.role === 'MEMBER'
      if (!outranks) {
        throw new ORPCError('FORBIDDEN', { message: 'Only the lead can remove a deputy' })
      }
      await prisma.$transaction(async (tx) => {
        await tx.onboardingMember.delete({ where: { volunteerId: member.volunteerId } })
        const hosted = await tx.onboardingCall.findMany({
          where: { hostId: member.volunteerId, cancelledAt: null, startsAt: { gt: new Date() } },
          select: { id: true },
        })
        for (const call of hosted) {
          await tx.onboardingCall.update({ where: { id: call.id }, data: freshHost(null) })
        }
      })
      return { message: 'Removed from the team' }
    }),

  /** The lead names deputies, who can then manage the team too. */
  setRole: memberProcedure
    .input(
      z.object({
        volunteerId: z.number().int(),
        role: z.enum([OnboardingRole.DEPUTY, OnboardingRole.MEMBER]),
      }),
    )
    .handler(async ({ input, context }) => {
      if (context.role !== 'LEAD' && !context.access.globalAdmin) {
        throw new ORPCError('FORBIDDEN', { message: 'Only the lead names deputies' })
      }
      const { count } = await prisma.onboardingMember.updateMany({
        where: { volunteerId: input.volunteerId, role: { not: OnboardingRole.LEAD } },
        data: { role: input.role },
      })
      if (!count) throw new ORPCError('NOT_FOUND')
      return { message: input.role === 'DEPUTY' ? 'Now a deputy' : 'No longer a deputy' }
    }),

  /** A global admin names the lead, who joins the team if not on it; the old lead stays on. */
  setLead: adminProcedure.input(z.object({ email: z.email() })).handler(async ({ input }) => {
    const volunteer = await prisma.volunteer.findFirst({
      where: { ...ELIGIBLE, email: { equals: input.email.trim(), mode: 'insensitive' } },
      select: { id: true, name: true },
    })
    if (!volunteer) {
      throw new ORPCError('NOT_FOUND', {
        message: 'No approved Action Hub account has that address',
      })
    }
    await prisma.$transaction([
      prisma.onboardingMember.updateMany({
        where: { role: OnboardingRole.LEAD },
        data: { role: OnboardingRole.MEMBER },
      }),
      prisma.onboardingMember.upsert({
        where: { volunteerId: volunteer.id },
        create: { volunteerId: volunteer.id, role: OnboardingRole.LEAD },
        update: { role: OnboardingRole.LEAD },
      }),
    ])
    return { message: `${volunteer.name} leads Global Onboarding` }
  }),

  /** What a reminder's link is about, for the page it opens; no sign-in needed. */
  byToken: publicProcedure
    .input(z.object({ token: z.string().min(1).max(100) }))
    .handler(async ({ input }) => {
      const call = await liveCallByToken(input.token)
      return {
        name: call.name,
        startsAt: call.startsAt,
        hostName: call.host!.name,
        confirmed: call.confirmedAt !== null,
        coverRequested: call.coverRequestedAt !== null,
      }
    }),

  /** A reminder's "I'm on" or "I need cover", on the host's behalf. */
  respond: publicProcedure
    .input(z.object({ token: z.string().min(1).max(100), answer: z.enum(['on', 'cover']) }))
    .handler(async ({ input }) => {
      const call = await liveCallByToken(input.token)
      if (input.answer === 'on') {
        await confirm(call.id)
        return { message: "Thanks, you're on. See you there!" }
      }
      await requestCover(call.id)
      return {
        message: "Thanks for letting us know. We'll ask the rest of the team to cover it.",
      }
    }),
}
