import { test, expect, getAlert } from '../fixtures'
import { createApprovedVolunteerNamed, readAdminToken, signedInPage } from '../fixtures'
import { createApiClient } from '../client'
import { fake } from '../fake'

// A coordinator pushes a request for help out as a call; a volunteer answers by taking it.
test.describe('Requests sent as calls', () => {
  test('A coordinator sends a request as a call, and a volunteer takes it from Calls', async ({
    browser,
    baseUrl,
    snap,
  }) => {
    const adminApi = createApiClient(baseUrl, readAdminToken(baseUrl))
    const coordinator = await createApprovedVolunteerNamed(baseUrl, fake.personName())
    await adminApi.admin.coordinators.appoint({
      body: { volunteerId: coordinator.id, remit: 'Media' },
    })
    const asker = await createApprovedVolunteerNamed(baseUrl, fake.personName())
    const taker = await createApprovedVolunteerNamed(baseUrl, fake.personName())
    const request = fake.quickTaskTitle()
    const asked = await createApiClient(baseUrl, asker.token).requests.ask({
      body: { title: request, description: 'Two pages', global: true },
    })
    const { id, projectId } = asked.body as { id: number; projectId: number }

    const coordinating = await signedInPage(browser, coordinator.token)
    await coordinating.goto(`${baseUrl}/projects/${projectId}/tasks/${id}`)
    await coordinating.getByRole('button', { name: 'Send as a call' }).click()
    const dialog = coordinating.getByRole('dialog', { name: 'Send as a call' })
    await expect(dialog.getByLabel('Title')).toHaveValue(request)
    await snap(coordinating, 'send request as call')
    await dialog.getByRole('button', { name: 'Send call' }).click()
    await expect(getAlert(coordinating)).toContainText('Your call is on its way to volunteers')

    const answering = await signedInPage(browser, taker.token)
    await answering.goto(`${baseUrl}/calls`)
    const received = answering.getByRole('region', { name: request })
    await expect(received.getByText(/makes the request yours/)).toBeVisible({ timeout: 10_000 })
    await received.getByRole('button', { name: 'Take this request' }).click()
    await expect(answering.getByRole('heading', { name: request, level: 1 })).toBeVisible({
      timeout: 10_000,
    })
    await expect(answering.getByText(`${asker.name} will look at it`)).toBeVisible()

    await coordinating.goto(`${baseUrl}/coordinate`)
    const sent = coordinating.locator('section').filter({ hasText: request })
    await sent.getByRole('button', { name: 'Answers (1)' }).click()
    await expect(sent.getByText(`Took '${request}'`)).toBeVisible()
  })
})
