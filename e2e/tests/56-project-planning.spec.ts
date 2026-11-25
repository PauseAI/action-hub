import { test, expect, getAlert } from '../fixtures'
import { fake } from '../fake'
import { proposeProject, adminApproveProject, transferProjectOwnership } from '../actions/projects'

test.describe('Project planning', () => {
  test('An approved proposal is planned: its outline item becomes a task, then planning finishes', async ({
    adminPage,
    volunteer,
    baseUrl,
    snap,
  }) => {
    const title = fake.projectTitle()
    // The proposal's one outline item is "Initial task".
    const projectId = await proposeProject(baseUrl, volunteer.page, title, 'A skeleton proposal')
    await adminApproveProject(baseUrl, adminPage, title)
    await transferProjectOwnership(baseUrl, adminPage, projectId, volunteer.name)

    const page = volunteer.page
    await page.goto(`${baseUrl}/projects/${projectId}#tasks`)
    const banner = page.getByRole('region', { name: 'Planning' })
    await expect(banner).toContainText('No tasks planned yet', { timeout: 10_000 })
    await expect(banner.getByRole('button', { name: 'Finish planning' })).toBeDisabled()
    const outline = page.getByRole('region', { name: 'Outline' })
    await expect(outline).toContainText('Initial task')
    await snap(page, 'planning with an outline')

    await outline.getByRole('button', { name: 'Plan as task' }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog.getByLabel('Task title')).toHaveValue('Initial task')
    await dialog.getByLabel('Helpers wanted (optional)').fill('2')
    await snap(page, 'planning an outline item')
    await dialog.getByRole('button', { name: 'Make it a task' }).click()
    await expect(getAlert(page)).toContainText('Planned as a task', { timeout: 10_000 })
    await expect(outline).toHaveCount(0)
    await expect(banner).toContainText('1 task planned')

    await banner.getByRole('button', { name: 'Finish planning' }).click()
    await expect(getAlert(page)).toContainText('Planning finished', { timeout: 10_000 })
    await expect(banner).toHaveCount(0)
    await expect(page.getByText('Initial task')).toBeVisible()
  })

  test('A volunteer who is not the owner sees the project being planned, and cannot take its outline', async ({
    adminPage,
    volunteer,
    baseUrl,
  }) => {
    const title = fake.projectTitle()
    const projectId = await proposeProject(baseUrl, volunteer.page, title, 'Not mine to plan')
    await adminApproveProject(baseUrl, adminPage, title)

    await volunteer.page.goto(`${baseUrl}/projects/${projectId}#tasks`)
    await expect(volunteer.page.getByRole('region', { name: 'Planning' })).toContainText(
      'Its tasks open up as the owner plans them.',
      { timeout: 10_000 },
    )
    const outline = volunteer.page.getByRole('region', { name: 'Outline' })
    await expect(outline).toContainText('Initial task')
    await expect(outline.getByRole('button')).toHaveCount(0)
  })
})
