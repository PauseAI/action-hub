import { describe, it, expect, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { prisma } from '@/lib/prisma'
import {
  createChapter,
  createCoordinator,
  createMember,
  createSkill,
  createVolunteer,
} from '@/test/factories'
import { clientAs } from '@/test/rpc'
import { navigation } from '@/test/next-navigation'
import { renderApp } from '@/test/render'
import CallsPage from './page'

/** A call from a fresh coordinator, addressed to everyone. */
async function postCall({
  skillIds = [],
  ...overrides
}: {
  title: string
  closedAt?: Date
  skillIds?: number[]
}) {
  const coordinator = await createCoordinator(undefined, { name: 'Caio Coordinator' })
  return prisma.call.create({
    data: {
      senderId: coordinator.id,
      body: 'Send us photos of your event.',
      skills: { create: skillIds.map((skillId) => ({ skillId })) },
      ...overrides,
    },
  })
}

const card = async (title: string) =>
  (await screen.findByRole('heading', { name: title })).closest('section') as HTMLElement

describe('calls for volunteers', () => {
  it('answers a call, updates the answer and withdraws it', async () => {
    const me = await createVolunteer({ consentMakeProfileVisibleInDirectory: false })
    const skill = await createSkill({ name: 'Filming' })
    await prisma.volunteerSkill.create({ data: { volunteerId: me.id, skillId: skill.id } })
    const call = await postCall({ title: 'Film the march', skillIds: [skill.id] })
    await renderApp(<CallsPage />, { as: me })

    const section = await card('Film the march')
    const matching = screen.getByRole('heading', { name: 'Calls that match your skills' })
    expect(matching.closest('section')).toContainElement(section)
    expect(within(section).getByText(/Caio Coordinator · Media coordinator/)).toBeInTheDocument()
    expect(within(section).getByText(/for Filming/)).toBeInTheDocument()
    expect(
      within(section).getByText(/Answering shares your name, email address/),
    ).toBeInTheDocument()

    const box = within(section).getByLabelText('Answer this call')
    await userEvent.type(box, 'I film in Leeds')
    await userEvent.click(within(section).getByRole('button', { name: 'Send answer' }))
    await screen.findByText(/the coordinator can now see your answer/)
    const answered = { callId: call.id, volunteerId: me.id }
    expect(await prisma.callResponse.findFirstOrThrow({ where: answered })).toMatchObject({
      message: 'I film in Leeds',
    })

    await userEvent.clear(await within(section).findByLabelText('Your answer'))
    await userEvent.type(within(section).getByLabelText('Your answer'), 'Leeds and York')
    await userEvent.click(within(section).getByRole('button', { name: 'Update answer' }))
    await waitFor(async () =>
      expect((await prisma.callResponse.findFirstOrThrow({ where: answered })).message).toBe(
        'Leeds and York',
      ),
    )

    await userEvent.click(within(section).getByRole('button', { name: 'Withdraw answer' }))
    await screen.findByText('Your answer is withdrawn')
    expect(await prisma.callResponse.count({ where: answered })).toBe(0)
    expect(await within(section).findByLabelText('Answer this call')).toHaveValue('')
  })

  it('shows a closed call the volunteer answered, without the form', async () => {
    const me = await createVolunteer()
    const call = await postCall({ title: 'Closed photo call' })
    await prisma.callResponse.create({
      data: { callId: call.id, volunteerId: me.id, message: 'Sent you mine' },
    })
    await prisma.call.update({ where: { id: call.id }, data: { closedAt: new Date() } })
    await prisma.call.update({ where: { id: call.id }, data: { senderId: null } })
    await renderApp(<CallsPage />, { as: me })

    const section = await card('Closed photo call')
    expect(within(section).getByText(/A coordinator/)).toBeInTheDocument()
    expect(within(section).getByText(/closed/)).toBeInTheDocument()
    expect(within(section).getByText(/You answered on .*: Sent you mine/)).toBeInTheDocument()
    expect(within(section).queryByRole('textbox')).not.toBeInTheDocument()
  })

  it('says so when there are no calls, and leaves out the other calls', async () => {
    await prisma.call.updateMany({ data: { closedAt: new Date() } })
    await renderApp(<CallsPage />, { as: await createVolunteer() })
    expect(await screen.findByText('No calls match your skills right now')).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Other calls' })).not.toBeInTheDocument()
  })

  it('puts calls for a skill the volunteer lacks under other calls, labelled and answerable', async () => {
    await prisma.call.updateMany({ data: { closedAt: new Date() } })
    const me = await createVolunteer()
    const drones = await createSkill({ name: 'Drone piloting' })
    const aerial = await createSkill({ name: 'Aerial photography' })
    const call = await postCall({ title: 'Fly over the march', skillIds: [drones.id, aerial.id] })
    await renderApp(<CallsPage />, { as: me })

    const other = (await screen.findByRole('heading', { name: 'Other calls' })).closest(
      'section',
    ) as HTMLElement
    const section = await card('Fly over the march')
    expect(other).toContainElement(section)
    expect(screen.getByText('No calls match your skills right now')).toBeInTheDocument()
    expect(
      within(section).getByText('Asks for Aerial photography or Drone piloting'),
    ).toBeInTheDocument()

    await userEvent.type(within(section).getByLabelText('Answer this call'), 'I fly one')
    await userEvent.click(within(section).getByRole('button', { name: 'Send answer' }))
    await screen.findByText(/the coordinator can now see your answer/)
    expect(
      await prisma.callResponse.count({ where: { callId: call.id, volunteerId: me.id } }),
    ).toBe(1)
  })

  it('reports a refused answer and a refused withdrawal', async () => {
    const me = await createVolunteer()
    const call = await postCall({ title: 'Refused call' })
    await prisma.callResponse.create({
      data: { callId: call.id, volunteerId: me.id, message: 'Here' },
    })
    await renderApp(<CallsPage />, { as: me })
    const section = await card('Refused call')
    await prisma.call.update({ where: { id: call.id }, data: { closedAt: new Date() } })
    await userEvent.click(within(section).getByRole('button', { name: 'Update answer' }))
    await screen.findByText('This call is no longer taking answers')

    await prisma.callResponse.deleteMany({ where: { callId: call.id } })
    await userEvent.click(within(section).getByRole('button', { name: 'Withdraw answer' }))
    await screen.findByText('You have not answered this call')
  })

  it('sends nothing for an empty answer submitted with Enter', async () => {
    const me = await createVolunteer()
    await postCall({ title: 'Empty answer call' })
    await renderApp(<CallsPage />, { as: me })
    const section = await card('Empty answer call')
    const respond = vi.spyOn(prisma.callResponse, 'upsert')
    within(section).getByRole('button', { name: 'Send answer' }).closest('form')!.requestSubmit()
    expect(respond).not.toHaveBeenCalled()
    respond.mockRestore()
  })

  it('folds a dismissed call away, where it can be restored or answered', async () => {
    const me = await createVolunteer()
    const call = await postCall({ title: 'Banner painting' })
    const other = await postCall({ title: 'Leaflet run' })
    await renderApp(<CallsPage />, { as: me })

    await userEvent.click(
      within(await card('Banner painting')).getByRole('button', {
        name: 'Dismiss Banner painting',
      }),
    )
    const toggle = await screen.findByRole('button', { name: 'Dismissed (1)' })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('heading', { name: 'Banner painting' })).not.toBeInTheDocument()
    await userEvent.click(toggle)
    const dismissed = await card('Banner painting')
    expect(toggle.closest('section')).toContainElement(dismissed)
    await userEvent.click(
      within(dismissed).getByRole('button', { name: 'Restore Banner painting' }),
    )
    await screen.findByText('Call restored')
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /Dismissed/ })).not.toBeInTheDocument(),
    )
    expect(await prisma.callDismissal.count({ where: { callId: call.id } })).toBe(0)

    await prisma.callDismissal.create({ data: { callId: other.id, volunteerId: me.id } })
    await userEvent.click(
      within(await card('Banner painting')).getByRole('button', {
        name: 'Dismiss Banner painting',
      }),
    )
    // The group stays as it was last left: open.
    expect(await screen.findByRole('button', { name: 'Dismissed (2)' })).toHaveAttribute(
      'aria-expanded',
      'true',
    )
    const leaflet = await card('Leaflet run')
    await userEvent.type(within(leaflet).getByLabelText('Answer this call'), 'I will')
    await userEvent.click(within(leaflet).getByRole('button', { name: 'Send answer' }))
    await screen.findByRole('button', { name: 'Dismissed (1)' })
    expect(await prisma.callDismissal.count({ where: { callId: other.id } })).toBe(0)
    expect(
      within(await card('Leaflet run')).queryByRole('button', { name: /Dismiss/ }),
    ).not.toBeInTheDocument()
  })
})

describe('a call that carries a request for help', () => {
  it('is answered by taking the request, and then says so', async () => {
    const chapter = await createChapter()
    const asker = await createMember(chapter)
    const me = await createMember(chapter)
    const coordinator = await createCoordinator(chapter, { name: 'Caio Coordinator' })
    const asked = await clientAs(asker).requests.ask({ title: 'Proofread the flyer' })
    await clientAs(coordinator).calls.send({
      title: 'Proofreader wanted',
      body: 'Two pages',
      chapterIds: [chapter.id],
      skillIds: [],
      requestId: asked.id,
    })
    const href = `/projects/${asked.projectId}/tasks/${asked.id}`
    await renderApp(<CallsPage />, { as: me })
    const section = within(await card('Proofreader wanted'))
    expect(section.queryByLabelText('Answer this call')).toBeNull()
    expect(section.getByText(/makes the request yours/)).toBeInTheDocument()
    await userEvent.click(section.getByRole('button', { name: 'Take this request' }))
    await screen.findByText('The request is yours')
    await waitFor(() => expect(navigation.push).toHaveBeenCalledWith(href))
    expect(await section.findByText(/You are on this request/)).toBeInTheDocument()
    expect(section.getByRole('link', { name: 'Open the request' })).toHaveAttribute('href', href)
  })

  it('reports a refused answer, and drops a call whose request needs nobody else', async () => {
    const chapter = await createChapter()
    const asker = await createMember(chapter)
    const [me, other] = [await createMember(chapter), await createMember(chapter)]
    const coordinator = await createCoordinator(chapter)
    const asked = await clientAs(asker).requests.ask({ title: 'Run a stall', helpersWanted: 1 })
    const ids = { projectId: asked.projectId, taskId: asked.id }
    await clientAs(coordinator).calls.send({
      title: 'Stall helpers',
      body: 'Saturday',
      chapterIds: [chapter.id],
      skillIds: [],
      requestId: asked.id,
    })
    await clientAs(other).projects.updateTask({ ...ids, data: { assigneeId: other.id } })
    await renderApp(<CallsPage />, { as: me })
    const section = within(await card('Stall helpers'))
    expect(section.getByText(/makes you one of its helpers/)).toBeInTheDocument()
    // Someone takes the last place meanwhile.
    await prisma.workItem.update({ where: { id: asked.id }, data: { helpersWanted: null } })
    await userEvent.click(section.getByRole('button', { name: 'Help on it' }))
    await screen.findByText('This request needs nobody else now')
    // Needing nobody else, it takes no more answers and leaves the list.
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Stall helpers' })).toBeNull())
  })
})
