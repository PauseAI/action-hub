import { beforeEach, describe, it, expect, vi } from 'vitest'
import { prisma } from '@/lib/prisma'
import { ONBOARDING_SUBJECTS } from '@/lib/onboarding-emails'
import {
  createAdmin,
  createOnboardingCall,
  createOnboardingMember,
  createVolunteer,
} from '@/test/factories'
import { emails } from '@/test/fakes/email'
import { anon, clientAs } from '@/test/rpc'

const forbidden = { code: 'FORBIDDEN' }
const notFound = { code: 'NOT_FOUND' }
const conflict = { code: 'CONFLICT' }
const badRequest = { code: 'BAD_REQUEST' }

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR
const inDays = (days: number) => new Date(Date.now() + days * DAY)
const call = (id: number) => prisma.onboardingCall.findUniqueOrThrow({ where: { id } })

beforeEach(async () => {
  await prisma.onboardingCall.deleteMany()
  await prisma.onboardingSlot.deleteMany()
  await prisma.onboardingMember.deleteMany()
})

async function team() {
  const lead = await createOnboardingMember('LEAD', { name: 'Robin Lead' })
  const deputy = await createOnboardingMember('DEPUTY', { name: 'Dana Deputy' })
  const member = await createOnboardingMember('MEMBER', { name: 'Max Member' })
  const other = await createOnboardingMember('MEMBER', { name: 'Alex Other' })
  return { lead, deputy, member, other }
}

describe('who sees the section', () => {
  it('lets in the team and global admins, and nobody else', async () => {
    const { member } = await team()
    await createOnboardingCall()
    const seen = await clientAs(member).onboarding.overview()
    expect(seen).toMatchObject({ role: 'MEMBER', manages: false, isAdmin: false, lumaLive: false })
    expect(seen.calls).toHaveLength(1)
    expect(seen.members.map((m) => m.name)).toEqual([
      'Robin Lead',
      'Dana Deputy',
      'Max Member',
      'Alex Other',
    ])
    expect(await clientAs(await createAdmin()).onboarding.overview()).toMatchObject({
      role: null,
      manages: true,
      isAdmin: true,
    })
    await expect(clientAs(await createVolunteer()).onboarding.overview()).rejects.toMatchObject(
      forbidden,
    )
    await expect(anon().onboarding.overview()).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
  })

  it('tells the app which members are on the team', async () => {
    const { lead } = await team()
    expect((await clientAs(lead).auth.me()).onboardingRole).toBe('LEAD')
    expect((await clientAs(await createVolunteer()).auth.me()).onboardingRole).toBeNull()
  })
})

describe('hosting', () => {
  it('lets a member take a call nobody hosts, and nobody take it from them', async () => {
    const { member, other } = await team()
    const c = await createOnboardingCall({ startsAt: inDays(10) })
    await clientAs(member).onboarding.take({ callId: c.id })
    const taken = await call(c.id)
    expect(taken).toMatchObject({ hostId: member.id, confirmedAt: null })
    expect(taken.actionToken).not.toBe(c.actionToken)
    await expect(clientAs(other).onboarding.take({ callId: c.id })).rejects.toMatchObject(conflict)
    await expect(clientAs(member).onboarding.take({ callId: c.id })).rejects.toMatchObject(conflict)
  })

  it('lets a member take a close call whose host has not said they are on', async () => {
    const { member, other } = await team()
    const quiet = await createOnboardingCall({ hostId: other.id, startsAt: inDays(1) })
    const sure = await createOnboardingCall({
      hostId: other.id,
      startsAt: inDays(1),
      confirmedAt: new Date(),
    })
    const overview = await clientAs(member).onboarding.overview()
    expect(overview.calls.find((c) => c.id === quiet.id)?.takeable).toBe(true)
    expect(overview.calls.find((c) => c.id === sure.id)?.takeable).toBe(false)
    await clientAs(member).onboarding.take({ callId: quiet.id })
    expect((await call(quiet.id)).hostId).toBe(member.id)
    await expect(clientAs(member).onboarding.take({ callId: sure.id })).rejects.toMatchObject(
      conflict,
    )
  })

  it('takes a close call as confirmed, so no reminder follows', async () => {
    const { member } = await team()
    const c = await createOnboardingCall({ startsAt: inDays(2) })
    await clientAs(member).onboarding.take({ callId: c.id })
    expect((await call(c.id)).confirmedAt).not.toBeNull()
  })

  it('lets only team members host: not a global admin off the team', async () => {
    const c = await createOnboardingCall()
    await expect(
      clientAs(await createAdmin()).onboarding.take({ callId: c.id }),
    ).rejects.toMatchObject(forbidden)
  })

  it('refuses a call that has passed or was cancelled, or someone else just took', async () => {
    const { member, other } = await team()
    const past = await createOnboardingCall({ startsAt: inDays(-1) })
    const cancelled = await createOnboardingCall({ cancelledAt: new Date() })
    await expect(clientAs(member).onboarding.take({ callId: past.id })).rejects.toMatchObject(
      notFound,
    )
    await expect(clientAs(member).onboarding.take({ callId: cancelled.id })).rejects.toMatchObject(
      notFound,
    )

    const c = await createOnboardingCall()
    const spy = vi.spyOn(prisma.onboardingCall, 'findUnique').mockImplementationOnce((async () => {
      const before = await call(c.id)
      await prisma.onboardingCall.update({ where: { id: c.id }, data: { hostId: other.id } })
      return before
    }) as never)
    await expect(clientAs(member).onboarding.take({ callId: c.id })).rejects.toMatchObject({
      code: 'CONFLICT',
      message: 'Someone else just took it',
    })
    spy.mockRestore()
  })

  it('lets the host confirm, ask for cover, then take the request back by confirming', async () => {
    const { member, other } = await team()
    const c = await createOnboardingCall({ hostId: member.id, teamAskedAt: new Date() })
    await expect(clientAs(other).onboarding.confirm({ callId: c.id })).rejects.toMatchObject(
      forbidden,
    )
    await clientAs(member).onboarding.requestCover({ callId: c.id })
    expect(await call(c.id)).toMatchObject({ confirmedAt: null, teamAskedAt: null })
    expect((await call(c.id)).coverRequestedAt).not.toBeNull()

    await clientAs(other).onboarding.take({ callId: c.id })
    expect(await call(c.id)).toMatchObject({ hostId: other.id, coverRequestedAt: null })

    await clientAs(other).onboarding.requestCover({ callId: c.id })
    await clientAs(other).onboarding.confirm({ callId: c.id })
    expect(await call(c.id)).toMatchObject({ coverRequestedAt: null })
    expect((await call(c.id)).confirmedAt).not.toBeNull()
  })

  it('lets the lead ask for cover on a host’s behalf, but not a member', async () => {
    const { lead, member, other } = await team()
    const c = await createOnboardingCall({ hostId: member.id })
    await expect(clientAs(other).onboarding.requestCover({ callId: c.id })).rejects.toMatchObject(
      forbidden,
    )
    await clientAs(lead).onboarding.requestCover({ callId: c.id })
    const open = await createOnboardingCall()
    await expect(clientAs(lead).onboarding.requestCover({ callId: open.id })).rejects.toMatchObject(
      badRequest,
    )
  })

  it('swaps two calls’ hosts and tells the other host', async () => {
    const { member, other } = await team()
    const mine = await createOnboardingCall({ hostId: member.id, confirmedAt: new Date() })
    const theirs = await createOnboardingCall({ hostId: other.id, startsAt: inDays(14) })
    await clientAs(member).onboarding.swap({ callId: mine.id, withCallId: theirs.id })
    expect(await call(mine.id)).toMatchObject({ hostId: other.id, confirmedAt: null })
    expect(await call(theirs.id)).toMatchObject({ hostId: member.id })
    expect(emails.lastTo(other.email!).subject).toBe(ONBOARDING_SUBJECTS.swapped('Max Member'))
  })

  it('refuses a swap that is not the host’s, or with a call nobody else hosts', async () => {
    const { member, other } = await team()
    const mine = await createOnboardingCall({ hostId: member.id })
    const open = await createOnboardingCall()
    const theirs = await createOnboardingCall({ hostId: other.id })
    await expect(
      clientAs(other).onboarding.swap({ callId: mine.id, withCallId: theirs.id }),
    ).rejects.toMatchObject(forbidden)
    await expect(
      clientAs(member).onboarding.swap({ callId: mine.id, withCallId: open.id }),
    ).rejects.toMatchObject(badRequest)
  })

  it('refuses a swap when one of the calls changed meanwhile', async () => {
    const { member, other, deputy } = await team()
    const mine = await createOnboardingCall({ hostId: member.id })
    const theirs = await createOnboardingCall({ hostId: other.id })
    const real = prisma.onboardingCall.findUnique.bind(prisma.onboardingCall)
    const spy = vi.spyOn(prisma.onboardingCall, 'findUnique')
    spy.mockImplementationOnce(real as never).mockImplementationOnce((async (args: never) => {
      const before = await real(args)
      await prisma.onboardingCall.update({ where: { id: theirs.id }, data: { hostId: deputy.id } })
      return before
    }) as never)
    await expect(
      clientAs(member).onboarding.swap({ callId: mine.id, withCallId: theirs.id }),
    ).rejects.toMatchObject(conflict)
    spy.mockRestore()
    expect(await call(mine.id)).toMatchObject({ hostId: member.id })
  })
})

describe('times and cancelling', () => {
  it('lets the host move their call, and Luma follows', async () => {
    const { member, other } = await team()
    const c = await createOnboardingCall({ hostId: member.id, confirmedAt: new Date() })
    await prisma.onboardingCall.update({ where: { id: c.id }, data: { lumaStale: false } })
    const startsAt = inDays(8)
    await clientAs(member).onboarding.setTime({ callId: c.id, startsAt })
    expect(await call(c.id)).toMatchObject({ startsAt, lumaStale: true })
    expect((await call(c.id)).confirmedAt).not.toBeNull()
    await expect(
      clientAs(other).onboarding.setTime({ callId: c.id, startsAt }),
    ).rejects.toMatchObject(forbidden)
    await expect(
      clientAs(member).onboarding.setTime({ callId: c.id, startsAt: inDays(-1) }),
    ).rejects.toMatchObject(badRequest)
  })

  it('asks the host again when the lead moves their call', async () => {
    const { lead, member } = await team()
    const c = await createOnboardingCall({ hostId: member.id, confirmedAt: new Date() })
    await prisma.onboardingCall.update({ where: { id: c.id }, data: { teamAskedAt: new Date() } })
    await clientAs(lead).onboarding.setTime({ callId: c.id, startsAt: inDays(9) })
    expect(await call(c.id)).toMatchObject({
      confirmedAt: null,
      remindedAt: null,
      teamAskedAt: null,
    })
  })

  it('lets the lead cancel any call, and a host only a close one nobody registered for', async () => {
    const { lead, member } = await team()
    const far = await createOnboardingCall({ hostId: member.id, lumaGuests: 0 })
    await expect(clientAs(member).onboarding.cancel({ callId: far.id })).rejects.toMatchObject(
      forbidden,
    )
    const empty = await createOnboardingCall({
      hostId: member.id,
      lumaGuests: 0,
      startsAt: new Date(Date.now() + 20 * HOUR),
    })
    const overview = await clientAs(member).onboarding.overview()
    expect(overview.calls.find((c) => c.id === empty.id)?.hostMayCancel).toBe(true)
    await clientAs(member).onboarding.cancel({ callId: empty.id })
    expect(await call(empty.id)).toMatchObject({ lumaStale: true })
    expect((await call(empty.id)).cancelledAt).not.toBeNull()
    await clientAs(lead).onboarding.cancel({ callId: far.id })
    expect((await call(far.id)).cancelledAt).not.toBeNull()
  })
})

describe('the lead’s tools', () => {
  it('adds a one-off call, and refuses one in the past', async () => {
    const { deputy, member } = await team()
    const startsAt = inDays(12)
    await clientAs(deputy).onboarding.add({ name: 'Extra call', startsAt })
    expect(await prisma.onboardingCall.findFirst({ where: { name: 'Extra call' } })).toMatchObject({
      startsAt,
    })
    await expect(
      clientAs(deputy).onboarding.add({ name: 'Old', startsAt: inDays(-1) }),
    ).rejects.toMatchObject(badRequest)
    await expect(clientAs(member).onboarding.add({ name: 'Mine', startsAt })).rejects.toMatchObject(
      forbidden,
    )
  })

  it('assigns a host, who is told, or nobody', async () => {
    const { lead, member } = await team()
    const c = await createOnboardingCall()
    await clientAs(lead).onboarding.assign({ callId: c.id, hostId: member.id })
    expect((await call(c.id)).hostId).toBe(member.id)
    expect(emails.lastTo(member.email!).subject).toBe(ONBOARDING_SUBJECTS.assigned(c.startsAt))
    expect(await clientAs(lead).onboarding.assign({ callId: c.id, hostId: member.id })).toEqual({
      message: 'No change',
    })
    await clientAs(lead).onboarding.assign({ callId: c.id, hostId: lead.id })
    expect(emails.to(lead.email!)).toHaveLength(0)
    expect(await clientAs(lead).onboarding.assign({ callId: c.id, hostId: null })).toEqual({
      message: 'Nobody is hosting it',
    })
    const outsider = await createVolunteer()
    await expect(
      clientAs(lead).onboarding.assign({ callId: c.id, hostId: outsider.id }),
    ).rejects.toMatchObject(badRequest)
  })

  it('adds a regular call, whose calls appear at once, and removes it', async () => {
    const { lead } = await team()
    const firstDay = new Date(Date.UTC(2099, 0, 7))
    await clientAs(lead).onboarding.saveSlot({
      name: 'Call B',
      firstDay,
      everyWeeks: 2,
      time: '16:00',
    })
    const [slot] = (await clientAs(lead).onboarding.overview()).slots
    expect(slot).toMatchObject({ name: 'Call B', firstDay, everyWeeks: 2, time: '16:00' })
    await expect(
      clientAs(lead).onboarding.saveSlot({ name: 'x', firstDay, everyWeeks: 2, time: '9am' }),
    ).rejects.toMatchObject(badRequest)
    await clientAs(lead).onboarding.removeSlot({ slotId: slot.id })
    await expect(clientAs(lead).onboarding.removeSlot({ slotId: slot.id })).rejects.toMatchObject(
      notFound,
    )
    const today = new Date(new Date().toISOString().slice(0, 10))
    await clientAs(lead).onboarding.saveSlot({
      name: 'Call C',
      firstDay: today,
      everyWeeks: 1,
      time: '23:59',
    })
    expect(await prisma.onboardingCall.count({ where: { name: 'Call C' } })).toBeGreaterThan(2)
  })

  it('drops today’s open call when a change would move it into the past', async () => {
    const { lead } = await team()
    const today = new Date(new Date().toISOString().slice(0, 10))
    const slot = await prisma.onboardingSlot.create({
      data: { name: 'Call C', firstDay: today, everyWeeks: 1, time: '23:59' },
    })
    const todays = await createOnboardingCall({
      slotId: slot.id,
      slotDay: today,
      startsAt: new Date(Date.now() + HOUR),
      lumaEventId: 'evt-today',
    })
    await clientAs(lead).onboarding.saveSlot({
      slotId: slot.id,
      name: 'Call C',
      firstDay: today,
      everyWeeks: 1,
      time: '00:00',
    })
    expect(await call(todays.id)).toMatchObject({ startsAt: todays.startsAt, lumaStale: true })
    expect((await call(todays.id)).cancelledAt).not.toBeNull()
  })

  it('moves the coming calls nobody hosts when a regular call changes, and leaves hosted ones', async () => {
    const { lead, member } = await team()
    const today = new Date(new Date().toISOString().slice(0, 10))
    await clientAs(lead).onboarding.saveSlot({
      name: 'Call C',
      firstDay: new Date(today.getTime() + DAY),
      everyWeeks: 1,
      time: '09:00',
    })
    const [first, second, third] = await prisma.onboardingCall.findMany({
      orderBy: { startsAt: 'asc' },
    })
    await prisma.onboardingCall.update({ where: { id: first.id }, data: { hostId: member.id } })
    await prisma.onboardingCall.update({
      where: { id: third.id },
      data: { lumaEventId: 'evt-x', lumaStale: false },
    })
    await clientAs(lead).onboarding.saveSlot({
      slotId: first.slotId!,
      name: 'Call C',
      firstDay: new Date(today.getTime() + DAY),
      everyWeeks: 2,
      time: '10:00',
    })
    expect((await call(first.id)).startsAt).toEqual(first.startsAt)
    expect(await prisma.onboardingCall.findUnique({ where: { id: second.id } })).toBeNull()
    expect(await call(third.id)).toMatchObject({
      startsAt: new Date(third.startsAt.getTime() + HOUR),
      lumaStale: true,
      cancelledAt: null,
    })
    await clientAs(lead).onboarding.saveSlot({
      slotId: first.slotId!,
      name: 'Call C',
      firstDay: new Date(today.getTime() + 2 * DAY),
      everyWeeks: 2,
      time: '10:00',
    })
    expect((await call(third.id)).cancelledAt).not.toBeNull()
  })

  it('saves the Meet link, an https one only, and what Luma shows, for every coming call', async () => {
    const { lead } = await team()
    const c = await createOnboardingCall()
    await prisma.onboardingCall.update({ where: { id: c.id }, data: { lumaStale: false } })
    const settings = { meetLink: 'https://meet.google.com/x', lumaTitle: 'Hi', lumaDescription: '' }
    await clientAs(lead).onboarding.saveSettings(settings)
    expect((await clientAs(lead).onboarding.overview()).settings).toEqual({
      ...settings,
      lumaDescription: null,
    })
    expect((await call(c.id)).lumaStale).toBe(true)
    await clientAs(lead).onboarding.saveSettings({ ...settings, meetLink: null })
    await expect(
      clientAs(lead).onboarding.saveSettings({ ...settings, meetLink: 'javascript:alert(1)' }),
    ).rejects.toMatchObject(badRequest)
  })
})

describe('the team', () => {
  it('adds someone by their address, only an approved account', async () => {
    const { deputy } = await team()
    const joining = await createVolunteer({ name: 'Lee New' })
    await clientAs(deputy).onboarding.addMember({ email: joining.email!.toUpperCase() })
    expect(
      await prisma.onboardingMember.findUnique({ where: { volunteerId: joining.id } }),
    ).toMatchObject({ role: 'MEMBER' })
    await clientAs(deputy).onboarding.addMember({ email: joining.email! })
    const pending = await createVolunteer({ approvalStatus: 'pending' })
    await expect(
      clientAs(deputy).onboarding.addMember({ email: pending.email! }),
    ).rejects.toMatchObject(notFound)
  })

  it('removes a member and frees the calls they were hosting, leaving cancelled ones be', async () => {
    const { deputy, member } = await team()
    const c = await createOnboardingCall({ hostId: member.id, confirmedAt: new Date() })
    const cancelled = await createOnboardingCall({ hostId: member.id, cancelledAt: new Date() })
    await prisma.onboardingCall.update({
      where: { id: cancelled.id },
      data: { lumaStale: false },
    })
    await clientAs(deputy).onboarding.removeMember({ volunteerId: member.id })
    expect(await call(c.id)).toMatchObject({ hostId: null, confirmedAt: null })
    expect(await call(cancelled.id)).toMatchObject({ hostId: member.id, lumaStale: false })
    await expect(
      clientAs(deputy).onboarding.removeMember({ volunteerId: member.id }),
    ).rejects.toMatchObject(notFound)
  })

  it('keeps deputies and the lead from being removed by anyone below them', async () => {
    const { lead, deputy } = await team()
    const second = await createOnboardingMember('DEPUTY')
    await expect(
      clientAs(deputy).onboarding.removeMember({ volunteerId: second.id }),
    ).rejects.toMatchObject(forbidden)
    await expect(
      clientAs(lead).onboarding.removeMember({ volunteerId: lead.id }),
    ).rejects.toMatchObject(forbidden)
    await clientAs(lead).onboarding.removeMember({ volunteerId: second.id })
    await clientAs(await createAdmin()).onboarding.removeMember({ volunteerId: lead.id })
  })

  it('lets only the lead name deputies, and never changes the lead that way', async () => {
    const { lead, deputy, member } = await team()
    await expect(
      clientAs(deputy).onboarding.setRole({ volunteerId: member.id, role: 'DEPUTY' }),
    ).rejects.toMatchObject(forbidden)
    expect(
      await clientAs(lead).onboarding.setRole({ volunteerId: member.id, role: 'DEPUTY' }),
    ).toEqual({ message: 'Now a deputy' })
    expect(
      await clientAs(lead).onboarding.setRole({ volunteerId: deputy.id, role: 'MEMBER' }),
    ).toEqual({ message: 'No longer a deputy' })
    await expect(
      clientAs(lead).onboarding.setRole({ volunteerId: lead.id, role: 'MEMBER' }),
    ).rejects.toMatchObject(notFound)
  })

  it('lets a global admin name the lead, who replaces the last', async () => {
    const { lead, member } = await team()
    const admin = clientAs(await createAdmin())
    await admin.onboarding.setLead({ email: member.email! })
    const roles = await prisma.onboardingMember.findMany({
      where: { volunteerId: { in: [lead.id, member.id] } },
    })
    expect(Object.fromEntries(roles.map((r) => [r.volunteerId, r.role]))).toEqual({
      [lead.id]: 'MEMBER',
      [member.id]: 'LEAD',
    })
    const outsider = await createVolunteer()
    await admin.onboarding.setLead({ email: outsider.email! })
    expect(
      await prisma.onboardingMember.findUnique({ where: { volunteerId: outsider.id } }),
    ).toMatchObject({ role: 'LEAD' })
    await expect(admin.onboarding.setLead({ email: 'nobody@example.com' })).rejects.toMatchObject(
      notFound,
    )
    await expect(
      clientAs(member).onboarding.setLead({ email: member.email! }),
    ).rejects.toMatchObject(forbidden)
  })
})

describe('reminder links', () => {
  it('shows the call and takes the host’s answer, signed out', async () => {
    const { member } = await team()
    const c = await createOnboardingCall({ hostId: member.id })
    expect(await anon().onboarding.byToken({ token: c.actionToken })).toMatchObject({
      name: 'Call B',
      hostName: 'Max Member',
      confirmed: false,
      coverRequested: false,
    })
    await anon().onboarding.respond({ token: c.actionToken, answer: 'cover' })
    expect((await call(c.id)).coverRequestedAt).not.toBeNull()
    await anon().onboarding.respond({ token: c.actionToken, answer: 'on' })
    expect(await call(c.id)).toMatchObject({ coverRequestedAt: null })
  })

  it('stops working once the call has a new host, has passed or was cancelled', async () => {
    const { member, other } = await team()
    const c = await createOnboardingCall({ hostId: member.id, coverRequestedAt: new Date() })
    await clientAs(other).onboarding.take({ callId: c.id })
    await expect(anon().onboarding.byToken({ token: c.actionToken })).rejects.toMatchObject(
      notFound,
    )
    const past = await createOnboardingCall({ hostId: member.id, startsAt: inDays(-1) })
    await expect(
      anon().onboarding.respond({ token: past.actionToken, answer: 'on' }),
    ).rejects.toMatchObject(notFound)
    const open = await createOnboardingCall()
    await expect(anon().onboarding.byToken({ token: open.actionToken })).rejects.toMatchObject(
      notFound,
    )
  })
})
