import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderApp } from '@/test/render'
import { navigation } from '@/test/next-navigation'
import { createVolunteer, createAdmin, createProject } from '@/test/factories'
import ErrorPage from './error'
import GlobalError from './global-error'
import { errorReports } from '@/test/fakes/error-reporter'
import NotFound from './not-found'
import Landing from './page'
import ProfileRedirect from './profile/page'
import EditProjectPage from './projects/[id]/edit/page'
import SuggestNewProjectPage from './suggest/new/page'
import AdminCreateProjectPage from './admin/projects/new/page'
import ProjectImportPage from './projects/[id]/import/page'
import sitemap from './sitemap'
import robots from './robots'
import manifest from './manifest'
import fs from 'fs'
import path from 'path'

describe('static pages', () => {
  it('error page logs and offers a retry', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const reset = vi.fn()
    render(<ErrorPage error={new Error('boom')} reset={reset} />)
    expect(error).toHaveBeenCalled()
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(reset).toHaveBeenCalled()
    expect(screen.getByRole('link', { name: 'Go home' })).toHaveAttribute('href', '/')
  })

  it('error page reports a client error, and leaves a server one to the server', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const error = new Error('boom')
    const { rerender } = render(<ErrorPage error={error} reset={() => {}} />)
    rerender(
      <ErrorPage error={Object.assign(new Error('rsc'), { digest: 'd1' })} reset={() => {}} />,
    )
    expect(errorReports.reports).toEqual([{ kind: 'exception', error }])
  })

  it('global error page reports a client error and offers a retry', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const retry = vi.fn()
    // It renders its own <html>, which React only warns about inside the test's container.
    const { rerender } = render(<GlobalError error="thrown string" retry={retry} />)
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(retry).toHaveBeenCalled()
    expect(screen.getByRole('link', { name: 'Go home' })).toHaveAttribute('href', '/')
    rerender(
      <GlobalError error={Object.assign(new Error('rsc'), { digest: 'd2' })} retry={retry} />,
    )
    rerender(<GlobalError error={null} retry={retry} />)
    expect(errorReports.reports).toEqual([
      { kind: 'exception', error: 'thrown string' },
      { kind: 'exception', error: null },
    ])
  })

  it('not-found and landing pages render', async () => {
    render(<NotFound />)
    expect(screen.getByText('Page not found')).toBeInTheDocument()
    await renderApp(<Landing />)
    expect(screen.getAllByRole('link', { name: 'Apply to join' }).length).toBeGreaterThan(0)
  })

  it('sitemap and robots derive from APP_URL', () => {
    expect(sitemap().map((e) => e.url)).toContain('http://localhost:3000/privacy')
    expect(robots().sitemap).toBe('http://localhost:3000/sitemap.xml')
  })

  it('manifest makes the app installable, with icons that exist', () => {
    const m = manifest()
    expect(m).toMatchObject({
      short_name: 'Action Hub',
      display: 'standalone',
      start_url: '/dashboard',
    })
    expect(m.icons?.map((icon) => icon.purpose)).toEqual(['any', 'any', 'maskable'])
    for (const icon of m.icons ?? []) {
      expect(fs.existsSync(path.join('public', icon.src)), icon.src).toBe(true)
    }
  })

  it('/profile redirects to settings', async () => {
    await renderApp(<ProfileRedirect />)
    expect(navigation.replace).toHaveBeenCalledWith('/settings')
  })
})

describe('editor host pages', () => {
  it('render nothing until signed in, then mount the editor', async () => {
    const me = await createVolunteer()
    const project = await createProject({ creatorId: me.id, status: 'draft', title: 'Hosted' })
    await renderApp(<EditProjectPage params={Promise.resolve({ id: String(project.id) })} />, {
      as: me,
    })
    await waitFor(() => expect(document.body.textContent).toContain('Edit project'))
    expect(await screen.findByDisplayValue('Hosted')).toBeInTheDocument()
    await waitFor(() => expect(document.title).toBe('Action Hub | Edit Hosted'))

    await renderApp(<SuggestNewProjectPage />, { as: me })
    expect(await screen.findByRole('heading', { name: 'Propose a project' })).toBeInTheDocument()

    await renderApp(<ProjectImportPage params={Promise.resolve({ id: String(project.id) })} />, {
      as: me,
    })
    expect(await screen.findByRole('heading', { name: 'Export and import' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Back to project' })).toHaveAttribute(
      'href',
      `/projects/${project.id}`,
    )

    const admin = await createAdmin()
    await renderApp(<AdminCreateProjectPage />, { as: admin })
    expect(await screen.findByRole('heading', { name: 'Org projects' })).toBeInTheDocument()
    await userEvent.click(screen.getAllByRole('button', { name: 'Cancel' }).at(-1)!)
    await waitFor(() => expect(navigation.push).toHaveBeenCalledWith('/admin/projects'))
  })
})
