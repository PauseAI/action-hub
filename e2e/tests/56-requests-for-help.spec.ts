import { test, expect, getAlert, createApprovedVolunteer } from '../fixtures'
import { createApiClient } from '../client'
import { fake } from '../fake'

test.describe('Requests for help', () => {
  test('A volunteer asks for help, someone takes it, and the asker accepts the work', async ({
    volunteer,
    baseUrl,
    snap,
  }) => {
    const page = volunteer.page
    const title = fake.quickTaskTitle()

    await page.goto(`${baseUrl}/quick-tasks`)
    await page.getByRole('button', { name: '+ Ask for help' }).click()
    const dialog = page.getByRole('dialog', { name: 'Ask for help' })
    await dialog.getByLabel('What do you need?').fill(title)
    await dialog.getByLabel('Details').fill('Two pages, before Friday')
    await dialog.getByLabel('Hours, roughly').fill('1')
    await snap(page, 'ask for help filled in')
    await dialog.getByRole('button', { name: 'Post request' }).click()
    await expect(getAlert(page)).toContainText('Request posted', { timeout: 10_000 })
    await expect(page.getByRole('heading', { name: title, level: 1 })).toBeVisible({
      timeout: 10_000,
    })
    await expect(page.getByText(`Asked by ${volunteer.name}`)).toBeVisible()
    const [, , projectId, , taskId] = new URL(page.url()).pathname.split('/')

    // Anyone takes it at once, without asking to join, and hands it in for the asker to review.
    const taker = await createApprovedVolunteer(baseUrl)
    const takerApi = createApiClient(baseUrl, taker.token)
    const ids = { projectId: Number(projectId), taskId: Number(taskId) }
    const taken = await takerApi.projects.updateTask({
      body: { ...ids, data: { assigneeId: taker.id } },
    })
    expect(taken.body).toMatchObject({ requested: false })
    await takerApi.projects.submitTask({ body: { ...ids, note: 'Proofread it' } })

    await page.goto(`${baseUrl}/quick-tasks`)
    const mine = page.getByRole('region', { name: 'Your requests for help' })
    await expect(mine.getByRole('article').filter({ hasText: title })).toContainText(
      `Taken by ${taker.name}`,
      { timeout: 10_000 },
    )
    await mine.getByRole('link', { name: title }).click()
    await expect(page.getByText('Proofread it')).toBeVisible({ timeout: 10_000 })
    await page.getByRole('button', { name: 'Accept', exact: true }).click()
    await expect(page.getByText(`${volunteer.name} accepted this as Done`)).toBeVisible({
      timeout: 10_000,
    })
  })

  test('An old quick-task link opens the request', async ({ volunteer, baseUrl }) => {
    const title = fake.quickTaskTitle()
    const asker = await createApprovedVolunteer(baseUrl)
    const api = createApiClient(baseUrl, asker.token)
    const asked = await api.requests.ask({ body: { title, global: true } })
    const { id, projectId } = asked.body as { id: number; projectId: number }
    await volunteer.page.goto(`${baseUrl}/quick-tasks/${id}`)
    await volunteer.page.waitForURL(`**/projects/${projectId}/tasks/${id}`)
    await expect(volunteer.page.getByRole('heading', { name: title, level: 1 })).toBeVisible()
  })
})
