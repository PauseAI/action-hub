import { describe, it, expect } from 'vitest'
import { screen, waitFor, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { prisma } from '@/lib/prisma'
import { createVolunteer, createAdmin } from '@/test/factories'
import { fullText, renderApp } from '@/test/render'
import { clientAs } from '@/test/rpc'
import { navigation } from '@/test/next-navigation'
import QuickTaskDetailPage from './quick-tasks/[id]/page'
import BugReportDetailPage from './bugs/[id]/page'

describe('an old quick-task link', () => {
  it('sends an old link to the request the quick task became', async () => {
    const me = await createVolunteer()
    const asked = await clientAs(me).requests.ask({ title: 'Was a quick task', global: true })
    await renderApp(<QuickTaskDetailPage params={Promise.resolve({ id: String(asked.id) })} />, {
      as: me,
    })
    await waitFor(() =>
      expect(navigation.replace).toHaveBeenCalledWith(
        `/projects/${asked.projectId}/tasks/${asked.id}`,
      ),
    )
    expect(screen.queryByText('Task not found.')).toBeNull()
  })

  it('says so when it cannot find out where a link leads', async () => {
    const me = await createVolunteer()
    // An id past Postgres's integer range fails the lookup outright.
    await renderApp(<QuickTaskDetailPage params={Promise.resolve({ id: '2147483648' })} />, {
      as: me,
    })
    await screen.findByText('Task not found.')
    expect(navigation.replace).not.toHaveBeenCalled()
    cleanup()
    for (const id of ['999999', 'nonsense']) {
      await renderApp(<QuickTaskDetailPage params={Promise.resolve({ id })} />, { as: me })
      expect(await screen.findByRole('link', { name: 'See open tasks' })).toHaveAttribute(
        'href',
        '/tasks',
      )
      cleanup()
    }
  })
})

describe('bug report detail', () => {
  it('shows a report to its reporter, and lets an admin update it', async () => {
    const reporter = await createVolunteer()
    const admin = await createAdmin({ name: 'Fixer' })
    const { id } = await clientAs(reporter).bugReports.create({
      title: 'Broken button',
      description: 'It does nothing at all',
      pageUrl: 'https://evil.example/projects/3?x=1',
      category: 'ux',
      severity: 'high',
    })
    await prisma.bugReport.update({
      where: { id },
      data: { assigneeId: admin.id, resolutionNotes: 'Looking into it' },
    })
    await renderApp(<BugReportDetailPage params={Promise.resolve({ id: String(id) })} />, {
      as: reporter,
    })
    await screen.findByRole('heading', { name: 'Broken button' })
    expect(screen.getByRole('link', { name: '/projects/3?x=1' })).toHaveAttribute(
      'href',
      '/projects/3?x=1',
    )
    expect(screen.getByText('Resolution: Looking into it')).toBeInTheDocument()
    expect(screen.queryByText(/Assigned to/)).toBeNull()
    expect(screen.queryByRole('button', { name: 'Update' })).toBeNull()

    cleanup()
    await renderApp(<BugReportDetailPage params={Promise.resolve({ id: String(id) })} />, {
      as: admin,
    })
    await screen.findByText(fullText(/^· Assigned to: Fixer/))
    expect(screen.getByRole('link', { name: '← Back to bug reports' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Assign to me' })).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'Unassign' }))
    await waitFor(() => expect(screen.queryByText(/Assigned to/)).toBeNull())
    await userEvent.click(screen.getByRole('button', { name: 'Assign to me' }))
    await screen.findByText(fullText(/^· Assigned to: Fixer/))
    await userEvent.click(screen.getByRole('button', { name: 'Status' }))
    await userEvent.click(screen.getByRole('option', { name: 'Resolved' }))
    await userEvent.clear(screen.getByLabelText('Resolution notes'))
    await userEvent.type(screen.getByLabelText('Resolution notes'), 'Fixed in #12')
    await userEvent.click(screen.getByRole('button', { name: 'Update' }))
    await screen.findByText('Report updated!')
    await waitFor(async () =>
      expect(await prisma.bugReport.findUniqueOrThrow({ where: { id } })).toMatchObject({
        status: 'resolved',
        resolutionNotes: 'Fixed in #12',
      }),
    )
    await prisma.bugReport.delete({ where: { id } })
    await userEvent.click(screen.getByRole('button', { name: 'Update' }))
    await screen.findByText('Bug report not found')
  })

  it('renders unlinkable page URLs as text, and a not-found state', async () => {
    const admin = await createAdmin()
    const report = await prisma.bugReport.create({
      data: {
        title: 'Odd URL',
        description: 'Ten characters at least',
        pageUrl: 'mailto:x@y.z',
        category: null,
        severity: null,
      },
    })
    await renderApp(<BugReportDetailPage params={Promise.resolve({ id: String(report.id) })} />, {
      as: admin,
    })
    await screen.findByText(/mailto:x@y\.z/)
    expect(screen.queryByRole('link', { name: /mailto/ })).toBeNull()
    cleanup()
    await renderApp(<BugReportDetailPage params={Promise.resolve({ id: '999999' })} />, {
      as: admin,
    })
    await screen.findByRole('heading', { name: 'Report not found' })
    expect(screen.getByRole('link', { name: 'Go to dashboard' })).toHaveAttribute(
      'href',
      '/dashboard',
    )
  })
})
