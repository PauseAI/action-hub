import { describe, it, expect } from 'vitest'
import { screen, waitFor, fireEvent, cleanup, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { prisma } from '@/lib/prisma'
import {
  createVolunteer,
  createProject,
  createTask,
  createChapter,
  createChapterLead,
  createMember,
} from '@/test/factories'
import { renderApp } from '@/test/render'
import { queryClient } from '@/lib/query-client'
import { navigation } from '@/test/next-navigation'
import { clientAs } from '@/test/rpc'
import TasksPage from './page'

/** The page picks its opening tab once every list has loaded, after the tab labels show. */
const opensOn = (name: string) =>
  waitFor(() => expect(screen.getByRole('tab', { name })).toHaveAttribute('aria-selected', 'true'))
const row = (id: number) => prisma.workItem.findUniqueOrThrow({ where: { id } })
const card = async (title: string) =>
  within(
    (await screen.findByRole('link', { name: title })).closest('[role=article]') as HTMLElement,
  )

describe('the Tasks page', () => {
  it('asks for help, lists the request for others to take, and shows it to the asker', async () => {
    const chapter = await createChapter()
    const asker = await createMember(chapter, { name: 'Ada Asker' })
    const taker = await createMember(chapter, { name: 'Tom Taker' })
    await renderApp(<TasksPage />, { as: asker })
    await screen.findByText('Nothing open right now')
    await userEvent.click(await screen.findByRole('button', { name: '+ Ask for help' }))
    const dialog = await screen.findByRole('dialog', { name: 'Ask for help' })
    expect(
      within(dialog).getByText(new RegExp(`Anyone in ${chapter.name} can take it`)),
    ).toBeInTheDocument()
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog')).toBeNull()

    await userEvent.click(screen.getByRole('button', { name: '+ Ask for help' }))
    const again = await screen.findByRole('dialog', { name: 'Ask for help' })
    // A request the server refuses says why, and the form stays open.
    fireEvent.submit(within(again).getByLabelText('What do you need?').closest('form')!)
    await screen.findByText('Title is required')
    await userEvent.type(within(again).getByLabelText('What do you need?'), 'Proofread the flyer')
    await userEvent.type(within(again).getByLabelText('Details'), 'Two pages')
    await userEvent.type(within(again).getByLabelText('Hours, roughly'), '2')
    fireEvent.change(within(again).getByLabelText('Needed by'), {
      target: { value: '2099-03-04' },
    })
    await userEvent.type(within(again).getByLabelText('Helpers as well'), '1')
    await userEvent.click(within(again).getByText(/Ask people in every chapter/))
    expect(within(again).getByText(/Anyone in any chapter can take it/)).toBeInTheDocument()
    await userEvent.click(within(again).getByText(/Ask people in every chapter/))
    await userEvent.click(within(again).getByRole('button', { name: 'Post request' }))
    const request = await waitFor(async () =>
      prisma.workItem.findFirstOrThrow({ where: { title: 'Proofread the flyer' } }),
    )
    expect(request).toMatchObject({
      creatorId: asker.id,
      description: 'Two pages',
      estimatedHours: 2,
      helpersWanted: 1,
    })
    await waitFor(() =>
      expect(navigation.push).toHaveBeenCalledWith(
        `/projects/${request.parentId}/tasks/${request.id}`,
      ),
    )
    cleanup()
    queryClient.clear()

    await renderApp(<TasksPage />, { as: taker })
    const open = await card('Proofread the flyer')
    expect(open.getByText('Asked by Ada Asker')).toBeInTheDocument()
    expect(open.getByText('~2h')).toBeInTheDocument()
    expect(open.getByText('Due 4 Mar 2099')).toBeInTheDocument()
    await userEvent.click(open.getByRole('button', { name: 'Claim task' }))
    await screen.findByText(/^Task claimed/)
    await waitFor(async () => expect((await row(request.id)).assigneeId).toBe(taker.id))
    cleanup()
    queryClient.clear()

    // What they took is theirs under Mine.
    await renderApp(<TasksPage />, { as: taker })
    await opensOn('Mine (1)')
    const doing = (await screen.findByRole('heading', { name: "You're doing" })).closest('section')!
    expect(within(doing).getByRole('link', { name: 'Proofread the flyer' })).toBeInTheDocument()
    cleanup()
    queryClient.clear()

    await renderApp(<TasksPage />, { as: asker })
    const mine = (await screen.findByRole('heading', { name: 'Your requests for help' })).closest(
      'section',
    )!
    expect(within(mine).getByText('Taken by Tom Taker')).toBeInTheDocument()
    expect(within(mine).getByRole('link', { name: 'Proofread the flyer' })).toHaveAttribute(
      'href',
      `/projects/${request.parentId}/tasks/${request.id}`,
    )
    expect(await screen.findByText('Nothing taken yet')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'See open tasks' }))
    // Taken, it still asks for a helper, in the asker's name.
    expect((await card('Proofread the flyer')).getByText(/Ada Asker is asking for/)).toBeTruthy()
  })

  it('asks everyone from the holding pool, and lists global requests to staff as well', async () => {
    const pooled = await createVolunteer({ name: 'Pat Pool' })
    const chapter = await createChapter()
    const lead = await createChapterLead(chapter)
    await renderApp(<TasksPage />, { as: pooled })
    await userEvent.click(await screen.findByRole('button', { name: '+ Ask for help' }))
    const dialog = await screen.findByRole('dialog', { name: 'Ask for help' })
    expect(within(dialog).queryByText(/Ask people in every chapter/)).toBeNull()
    await userEvent.type(within(dialog).getByLabelText('What do you need?'), 'Check a sheet')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Post request' }))
    await waitFor(() => expect(navigation.push).toHaveBeenCalled())
    cleanup()
    queryClient.clear()

    await renderApp(<TasksPage />, { as: lead })
    const global = await card('Check a sheet')
    expect(global.getByText('Every chapter')).toBeInTheDocument()
    expect(global.getByText('Asked by Pat Pool')).toBeInTheDocument()
  })

  it('opens on Open once every request asked for is done', async () => {
    const asker = await createMember(await createChapter())
    const done = await clientAs(asker).requests.ask({ title: 'Long done' })
    await prisma.workItem.update({ where: { id: done.id }, data: { status: 'completed' } })
    await renderApp(<TasksPage />, { as: asker })
    await opensOn('Open')
    await userEvent.click(screen.getByRole('tab', { name: 'Mine' }))
    expect(await screen.findByText('Long done')).toBeInTheDocument()
  })

  it('keeps work under Mine once handed in, with any changes asked for', async () => {
    const chapter = await createChapter()
    const asker = await createMember(chapter)
    const taker = await createMember(chapter)
    const take = async (title: string) => {
      const asked = await clientAs(asker).requests.ask({ title })
      const ids = { projectId: asked.projectId, taskId: asked.id }
      await clientAs(taker).projects.updateTask({ ...ids, data: { assigneeId: taker.id } })
      await clientAs(taker).projects.submitTask({ ...ids, note: 'Done' })
      return ids
    }
    await take('Waiting on review')
    const sentBack = await take('Sent back')
    await clientAs(asker).projects.requestTaskChanges({ ...sentBack, message: 'Add the date' })
    const done = await take('Accepted')
    await clientAs(asker).projects.acceptTask(done)

    await renderApp(<TasksPage />, { as: taker })
    // Done work stays listed but is not counted as on their plate.
    await opensOn('Mine (2)')
    expect((await card('Waiting on review')).getByRole('status')).toHaveTextContent('In review')
    expect((await card('Sent back')).getByText('Add the date')).toBeInTheDocument()
    expect((await card('Accepted')).getByRole('status')).toHaveTextContent('Done')
  })

  it('lists featured tasks and helper places, and says when one went meanwhile', async () => {
    const me = await createVolunteer()
    const owner = await createVolunteer({ name: 'Olive Owner' })
    const sam = await createVolunteer({ name: 'Sam' })
    const project = await createProject({ title: 'Briefing', assigneeId: owner.id })
    const featured = await createTask(project.id, {
      title: 'Featured task',
      featuredAsQuickTask: true,
      estimatedHours: 3,
      deadline: new Date('2099-05-06T00:00:00Z'),
    })
    const helped = await createTask(project.id, { title: 'Practise', helpersWanted: 2 })
    await prisma.workItemInterest.create({
      data: { workItemId: helped.id, volunteerId: sam.id, interestType: 'want_to_help_task' },
    })
    const gone = await createTask(project.id, { title: 'Gone', featuredAsQuickTask: true })
    const stall = await createTask(project.id, { title: 'Stall', helpersWanted: 1 })

    await renderApp(<TasksPage />, { as: me })
    const practise = await card('Practise')
    expect(practise.getByText('Part of:')).toBeInTheDocument()
    expect(practise.getByText('Olive Owner is asking for 2 helpers')).toBeInTheDocument()
    expect(practise.getByText('Sam has offered')).toBeInTheDocument()
    const feature = await card('Featured task')
    expect(feature.getByText('~3h')).toBeInTheDocument()
    expect(feature.getByText('Due 6 May 2099')).toBeInTheDocument()

    await prisma.workItem.delete({ where: { id: gone.id } })
    await userEvent.click((await card('Gone')).getByRole('button', { name: 'Ask to take this' }))
    await screen.findByText('Project or task not found')
    await prisma.workItem.update({ where: { id: stall.id }, data: { helpersWanted: null } })
    await userEvent.click((await card('Stall')).getByRole('button', { name: 'Offer to help' }))
    await screen.findByText('This task is not looking for helpers')

    await userEvent.click(practise.getByRole('button', { name: 'Offer to help' }))
    await screen.findByText(/^Offer sent/)
    await waitFor(() =>
      expect(navigation.push).toHaveBeenCalledWith(`/projects/${project.id}/tasks/${helped.id}`),
    )
    await userEvent.click(feature.getByRole('button', { name: 'Ask to take this' }))
    await screen.findByText(/^Requested\. The task is held for you/)
    expect(await row(featured.id)).toMatchObject({ assigneeId: null, requestedById: me.id })
  })
})
