import { beforeEach, describe, it, expect } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { prisma } from '@/lib/prisma'
import { NO_ACCESS_NOTICE_URL } from '@/lib/hooks/auth'
import { formatCallTime } from '@/lib/onboarding'
import {
  createAdmin,
  createOnboardingCall,
  createOnboardingMember,
  createVolunteer,
} from '@/test/factories'
import { navigation } from '@/test/next-navigation'
import { renderApp } from '@/test/render'
import OnboardingPage from './page'
import RespondPage from './respond/page'

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR
const inDays = (days: number) => new Date(Math.round((Date.now() + days * DAY) / HOUR) * HOUR)
const card = (name: string, at: Date) =>
  screen.findByRole('region', { name: `${name}, ${formatCallTime(at)}` })
const call = (id: number) => prisma.onboardingCall.findUniqueOrThrow({ where: { id } })

beforeEach(async () => {
  await prisma.onboardingCall.deleteMany()
  await prisma.onboardingSlot.deleteMany()
  await prisma.onboardingMember.deleteMany()
  await prisma.onboardingSettings.deleteMany()
})

describe('Global Onboarding, as a member', () => {
  it('takes a call, confirms it, asks for cover and swaps', async () => {
    const member = await createOnboardingMember('MEMBER', { name: 'Will Member' })
    const other = await createOnboardingMember('MEMBER', { name: 'Aarti Other' })
    const open = await createOnboardingCall({ startsAt: inDays(10) })
    const theirs = await createOnboardingCall({
      name: 'Call A',
      hostId: other.id,
      startsAt: inDays(14),
      lumaGuests: 3,
      lumaUrl: 'https://luma.com/abc',
    })
    await renderApp(<OnboardingPage />, { as: member })

    expect(await screen.findByText(/doesn.t talk to Luma/)).toBeInTheDocument()
    const theirCard = await card('Call A', theirs.startsAt)
    expect(within(theirCard).getByText(/3 registered/)).toBeInTheDocument()
    expect(within(theirCard).getByRole('link', { name: 'Luma page' })).toHaveAttribute(
      'href',
      'https://luma.com/abc',
    )
    expect(within(theirCard).getByText('Not confirmed yet')).toBeInTheDocument()

    const openCard = await card('Call B', open.startsAt)
    expect(within(openCard).getByText('Needs a host')).toBeInTheDocument()
    await userEvent.click(within(openCard).getByRole('button', { name: "I'll host" }))
    await screen.findByText("You're hosting it")
    await userEvent.click(await within(openCard).findByRole('button', { name: "I'm on" }))
    await screen.findByText("Thanks, you're on")
    expect(await within(openCard).findByText('Confirmed')).toBeInTheDocument()

    await userEvent.click(within(openCard).getByRole('button', { name: 'I need cover' }))
    await screen.findByText(/asked to cover it within the hour/)
    expect(await within(openCard).findByText('Cover needed')).toBeInTheDocument()

    await userEvent.selectOptions(within(openCard).getByLabelText('Swap with'), String(theirs.id))
    await userEvent.click(within(openCard).getByRole('button', { name: 'Swap' }))
    await screen.findByText('Swapped with Aarti Other')
    expect((await call(theirs.id)).hostId).toBe(member.id)
  })

  it('moves their call, and cancels one nobody registered for', async () => {
    const member = await createOnboardingMember()
    const c = await createOnboardingCall({
      hostId: member.id,
      startsAt: new Date(Date.now() + 20 * HOUR),
      lumaGuests: 0,
    })
    await renderApp(<OnboardingPage />, { as: member })
    const mine = await card('Call B', c.startsAt)
    await userEvent.click(within(mine).getByRole('button', { name: 'Change time' }))
    const at = inDays(5)
    const input = within(mine).getByLabelText('New time (UTC)')
    await userEvent.clear(input)
    await userEvent.type(input, at.toISOString().slice(0, 16))
    await userEvent.click(within(mine).getByRole('button', { name: 'Save time' }))
    await screen.findByText('Time changed')
    expect((await call(c.id)).startsAt).toEqual(at)

    await prisma.onboardingCall.update({
      where: { id: c.id },
      data: { startsAt: new Date(Date.now() + 20 * HOUR) },
    })
    navigation.reset()
    const moved = await call(c.id)
    await renderApp(<OnboardingPage />, { as: member })
    const again = (
      await screen.findAllByRole('region', {
        name: `Call B, ${formatCallTime(moved.startsAt)}`,
      })
    ).at(-1)!
    await userEvent.click(within(again).getByRole('button', { name: 'Cancel call' }))
    await screen.findByText('Call cancelled')
    expect(await within(again).findByText('Cancelled')).toBeInTheDocument()
  })

  it('says so when there are no calls, and shows the Meet link', async () => {
    const member = await createOnboardingMember()
    await prisma.onboardingSettings.create({ data: { meetLink: 'https://meet.google.com/x' } })
    await renderApp(<OnboardingPage />, { as: member })
    expect(await screen.findByText('No calls coming up')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'https://meet.google.com/x' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Regular calls' })).toBeNull()
  })

  it('shows an error from a refused action', async () => {
    const member = await createOnboardingMember()
    const c = await createOnboardingCall()
    await renderApp(<OnboardingPage />, { as: member })
    const open = await card('Call B', c.startsAt)
    await prisma.onboardingCall.update({ where: { id: c.id }, data: { cancelledAt: new Date() } })
    await userEvent.click(within(open).getByRole('button', { name: "I'll host" }))
    expect(await screen.findByText('That call has passed or was cancelled')).toBeInTheDocument()
  })
})

describe('Global Onboarding, as the lead', () => {
  it('adds calls and regular calls, assigns hosts, and sets the Meet link', async () => {
    const lead = await createOnboardingMember('LEAD', { name: 'Irina Lead' })
    const member = await createOnboardingMember('MEMBER', { name: 'Kelly Member' })
    const hosted = await createOnboardingCall({ hostId: member.id, startsAt: inDays(6) })
    await renderApp(<OnboardingPage />, { as: lead })

    expect(await screen.findByText('No regular calls yet')).toBeInTheDocument()
    const add = screen.getByRole('form', { name: 'Add a call' })
    await userEvent.clear(within(add).getByLabelText('Name'))
    await userEvent.type(within(add).getByLabelText('Name'), 'Call C')
    const at = inDays(20)
    await userEvent.type(within(add).getByLabelText('When (UTC)'), at.toISOString().slice(0, 16))
    await userEvent.click(within(add).getByRole('button', { name: 'Add call' }))
    await screen.findByText('Call added')
    const added = await card('Call C', at)

    await userEvent.selectOptions(within(added).getByLabelText('Host'), String(member.id))
    await screen.findByText('Kelly Member is hosting it')

    const hostedCard = await card('Call B', hosted.startsAt)
    await userEvent.click(within(hostedCard).getByRole('button', { name: 'Ask for cover' }))
    await screen.findByText(/asked to cover it within the hour/)
    await userEvent.click(within(hostedCard).getByRole('button', { name: 'Cancel call' }))
    await screen.findByText('Call cancelled')

    const slot = screen.getByRole('form', { name: 'Add a regular call' })
    await userEvent.type(within(slot).getByLabelText('Name'), 'Call A')
    await userEvent.type(within(slot).getByLabelText('First call'), '2099-01-07')
    await userEvent.type(within(slot).getByLabelText('Time (UTC)'), '14:00')
    await userEvent.click(within(slot).getByRole('button', { name: 'Add regular call' }))
    expect(
      await screen.findByText('Every other Wednesday at 14:00 UTC, from 7 Jan'),
    ).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Change Call A' }))
    const change = screen.getByRole('form', { name: 'Change Call A' })
    await userEvent.selectOptions(within(change).getByLabelText('Repeats'), '1')
    await userEvent.click(within(change).getByRole('button', { name: 'Save' }))
    expect(await screen.findByText('Every Wednesday at 14:00 UTC, from 7 Jan')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Remove Call A' }))
    await screen.findByText('Regular call removed')

    const settings = screen.getByRole('form', { name: 'Every call' })
    await userEvent.type(
      within(settings).getByLabelText('Google Meet link'),
      'https://meet.google.com/abc',
    )
    await userEvent.type(within(settings).getByLabelText('Title on Luma'), 'Welcome!')
    await userEvent.type(within(settings).getByLabelText('Description on Luma'), 'Come along')
    await userEvent.click(within(settings).getByRole('button', { name: 'Save' }))
    await screen.findByText('Saved; Luma is updated within the hour')
    expect(await prisma.onboardingSettings.findUnique({ where: { id: 1 } })).toMatchObject({
      meetLink: 'https://meet.google.com/abc',
      lumaTitle: 'Welcome!',
      lumaDescription: 'Come along',
    })
    await userEvent.clear(within(settings).getByLabelText('Google Meet link'))
    await userEvent.clear(within(settings).getByLabelText('Title on Luma'))
    await userEvent.clear(within(settings).getByLabelText('Description on Luma'))
    await userEvent.click(within(settings).getByRole('button', { name: 'Save' }))
    await waitFor(async () =>
      expect((await prisma.onboardingSettings.findUnique({ where: { id: 1 } }))?.meetLink).toBe(
        null,
      ),
    )
  })

  it('adds people to the team, names a deputy and removes people', async () => {
    const lead = await createOnboardingMember('LEAD', { name: 'Irina Lead' })
    await createOnboardingMember('MEMBER', { name: 'Kelly Member' })
    const joining = await createVolunteer({ name: 'Chay Joining' })
    await renderApp(<OnboardingPage />, { as: lead })

    await userEvent.type(
      await screen.findByLabelText('Add someone by their Action Hub email'),
      joining.email!,
    )
    await userEvent.click(screen.getByRole('button', { name: 'Add to team' }))
    await screen.findByText('Chay Joining is on the team')
    const row = (await screen.findByText('Chay Joining')).closest('li') as HTMLElement
    await userEvent.click(within(row).getByRole('button', { name: 'Make deputy' }))
    expect(await within(row).findByText('· Deputy')).toBeInTheDocument()
    await userEvent.click(within(row).getByRole('button', { name: 'Make member' }))
    await screen.findByText('No longer a deputy')
    await userEvent.click(screen.getByRole('button', { name: 'Remove Kelly Member from the team' }))
    await screen.findByText('Removed from the team')
    expect(screen.queryByRole('form', { name: 'Set the lead' })).toBeNull()
  })

  it('lets a deputy remove members but not name deputies', async () => {
    const deputy = await createOnboardingMember('DEPUTY')
    await createOnboardingMember('DEPUTY', { name: 'Other Deputy' })
    await createOnboardingMember('MEMBER', { name: 'Plain Member' })
    await renderApp(<OnboardingPage />, { as: deputy })
    const row = (await screen.findByText('Plain Member')).closest('li') as HTMLElement
    expect(within(row).queryByRole('button', { name: 'Make deputy' })).toBeNull()
    expect(within(row).getByRole('button', { name: /Remove/ })).toBeInTheDocument()
    const deputyRow = screen.getByText('Other Deputy').closest('li') as HTMLElement
    expect(within(deputyRow).queryByRole('button')).toBeNull()
  })
})

describe('Global Onboarding, as a global admin', () => {
  it('names the lead', async () => {
    const admin = await createAdmin()
    const irina = await createVolunteer({ name: 'Irina Tavera' })
    await renderApp(<OnboardingPage />, { as: admin })
    await userEvent.type(
      await screen.findByLabelText('Make lead (global admins only)'),
      irina.email!,
    )
    await userEvent.click(screen.getByRole('button', { name: 'Make lead' }))
    await screen.findByText('Irina Tavera leads Global Onboarding')
    expect(await screen.findByText('· Lead')).toBeInTheDocument()
  })

  it('turns away anyone off the team', async () => {
    await renderApp(<OnboardingPage />, { as: await createVolunteer() })
    await waitFor(() => expect(navigation.replace).toHaveBeenCalledWith(NO_ACCESS_NOTICE_URL))
  })

  it('sends the signed out to log in', async () => {
    await renderApp(<OnboardingPage />)
    await waitFor(() => expect(navigation.replace).toHaveBeenCalledWith('/login'))
  })
})

describe('reminder link page', () => {
  const open = (query: string) => {
    window.history.replaceState(null, '', `/onboarding/respond${query}`)
    return renderApp(<RespondPage />)
  }

  it('confirms with the button the email’s link chose, signed out', async () => {
    const host = await createOnboardingMember('MEMBER', { name: 'Sunyal Host' })
    const c = await createOnboardingCall({ hostId: host.id, name: 'Call A' })
    await open(`?token=${c.actionToken}&answer=on`)
    expect(
      await screen.findByRole('heading', { name: `Call A, ${formatCallTime(c.startsAt)}` }),
    ).toBeInTheDocument()
    expect(screen.getByText(/Sunyal Host, you.re hosting/)).toBeInTheDocument()
    expect((await call(c.id)).confirmedAt).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: "I'm on" }))
    expect(await screen.findByText(/Thanks, you.re on/)).toBeInTheDocument()
    expect((await call(c.id)).confirmedAt).not.toBeNull()
  })

  it('asks for cover, from either link', async () => {
    const host = await createOnboardingMember()
    const c = await createOnboardingCall({ hostId: host.id, confirmedAt: new Date() })
    await open(`?token=${c.actionToken}&answer=cover`)
    expect(await screen.findByText(/already said you.re on/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'I need cover' }))
    expect(await screen.findByText(/ask the rest of the team/)).toBeInTheDocument()

    await prisma.onboardingCall.update({
      where: { id: c.id },
      data: { coverRequestedAt: new Date() },
    })
    await open(`?token=${c.actionToken}&answer=cover`)
    expect(await screen.findByText(/You.ve asked for cover/)).toBeInTheDocument()
    await prisma.onboardingCall.update({ where: { id: c.id }, data: { cancelledAt: new Date() } })
    await userEvent.click(screen.getAllByRole('button', { name: "I'm on" }).at(-1)!)
    expect(await screen.findByRole('alert')).toHaveTextContent('This link no longer works')
  })

  it('says when the link is missing its code', async () => {
    await open('')
    expect(await screen.findByRole('alert')).toHaveTextContent('The link is missing its code')
  })

  it('says when the link no longer works', async () => {
    await open('?token=nope')
    expect(await screen.findByRole('alert')).toHaveTextContent('This link no longer works')
    expect(screen.getByRole('link', { name: 'Open Global Onboarding' })).toHaveAttribute(
      'href',
      '/onboarding',
    )
  })
})
