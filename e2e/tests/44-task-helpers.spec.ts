import {
  test,
  expect,
  getAlert,
  createApprovedVolunteerNamed,
  dismissCookieConsentScript,
  readAdminToken,
} from '../fixtures'
import { acceptIntoProject, adminCreateProjectViaApi, askToJoinViaApi } from '../actions/projects'
import { createApiClient } from '../client'
import { fake } from '../fake'

test.describe('Task helpers', () => {
  test('a member joins as a helper, a full slot blocks another, and removing one frees it for someone else', async ({
    volunteer,
    browser,
    baseUrl,
  }) => {
    const adminApi = createApiClient(baseUrl, readAdminToken(baseUrl))
    const title = fake.projectTitle()
    const projectId = await adminCreateProjectViaApi(baseUrl, title, 'Task helpers e2e project')
    const createdTask = await adminApi.projects.createTask({
      body: { projectId, title: 'Flyer the neighbourhood' },
    })
    expect(createdTask.status).toBe(200)
    const taskId = (createdTask.body as { id: number }).id
    expect(
      (
        await adminApi.projects.updateTask({
          body: { projectId, taskId, data: { helpersWanted: 1 } },
        })
      ).status,
    ).toBe(200)

    const lead = volunteer
    await lead.page.goto(`${baseUrl}/dashboard`)
    const leadToken = await lead.page.evaluate(() => localStorage.getItem('authToken'))
    await askToJoinViaApi(baseUrl, leadToken, projectId)
    await acceptIntoProject(adminApi, projectId, lead.name)

    const helperA = await createApprovedVolunteerNamed(baseUrl, fake.person().name)
    await askToJoinViaApi(baseUrl, helperA.token, projectId)
    await acceptIntoProject(adminApi, projectId, helperA.name)

    const helperB = await createApprovedVolunteerNamed(baseUrl, fake.person().name)
    await askToJoinViaApi(baseUrl, helperB.token, projectId)
    await acceptIntoProject(adminApi, projectId, helperB.name)

    const taskUrl = `${baseUrl}/projects/${projectId}/tasks/${taskId}`

    const leadPage = lead.page
    await leadPage.goto(taskUrl)
    await leadPage.getByRole('button', { name: 'Claim task' }).click()
    await leadPage
      .getByRole('dialog', { name: /^Claim '/ })
      .getByRole('button', { name: 'Claim task' })
      .click()
    await expect(leadPage.getByRole('button', { name: 'Claim task' })).toHaveCount(0, {
      timeout: 10_000,
    })
    await expect(
      leadPage.getByRole('region', { name: 'Helpers' }).getByText('1 helper wanted'),
    ).toBeVisible()

    const helperAContext = await browser.newContext()
    await helperAContext.addInitScript((t: string) => {
      localStorage.setItem('authToken', t)
    }, helperA.token)
    await helperAContext.addInitScript(dismissCookieConsentScript)
    const helperAPage = await helperAContext.newPage()

    const helperBContext = await browser.newContext()
    await helperBContext.addInitScript((t: string) => {
      localStorage.setItem('authToken', t)
    }, helperB.token)
    await helperBContext.addInitScript(dismissCookieConsentScript)
    const helperBPage = await helperBContext.newPage()

    await helperAPage.goto(taskUrl)
    await expect(
      helperAPage.getByRole('region', { name: 'Helpers' }).getByText('1 helper wanted'),
    ).toBeVisible()
    await helperAPage.getByRole('button', { name: 'Join as helper' }).click()
    await expect(helperAPage.getByText('1 helper', { exact: true })).toBeVisible({
      timeout: 10_000,
    })
    await expect(helperAPage.getByRole('button', { name: 'Withdraw from helping' })).toBeVisible()

    // The slot is taken: another member has no way to join.
    await helperBPage.goto(taskUrl)
    await expect(helperBPage.getByText('1 helper', { exact: true })).toBeVisible()
    await expect(helperBPage.getByRole('button', { name: 'Join as helper' })).toHaveCount(0)

    // The lead removes the helper, freeing the slot.
    await leadPage.reload()
    await leadPage.getByRole('button', { name: `Remove ${helperA.name}` }).click()
    await leadPage
      .getByRole('dialog', { name: `Remove ${helperA.name}?` })
      .getByRole('button', { name: 'Remove' })
      .click()
    await expect(
      leadPage.getByRole('region', { name: 'Helpers' }).getByText('1 helper wanted'),
    ).toBeVisible({ timeout: 10_000 })

    // The removed helper cannot rejoin, even though the slot is free again.
    await helperAPage.reload()
    await expect(helperAPage.getByRole('button', { name: 'Join as helper' })).toHaveCount(0)

    // The other member takes the free slot instead.
    await helperBPage.reload()
    await helperBPage.getByRole('button', { name: 'Join as helper' }).click()
    await expect(helperBPage.getByText('1 helper', { exact: true })).toBeVisible({
      timeout: 10_000,
    })

    await helperAContext.close()
    await helperBContext.close()
  })

  test('someone not on the project offers to help, and accepting puts them on the task and the project', async ({
    volunteer,
    adminPage,
    baseUrl,
    snap,
  }) => {
    const adminApi = createApiClient(baseUrl, readAdminToken(baseUrl))
    const projectId = await adminCreateProjectViaApi(
      baseUrl,
      fake.projectTitle(),
      'Offer to help e2e project',
    )
    const created = await adminApi.projects.createTask({
      body: { projectId, title: 'Practise the briefing' },
    })
    const taskId = (created.body as { id: number }).id
    await adminApi.projects.updateTask({ body: { projectId, taskId, data: { helpersWanted: 1 } } })
    const taskUrl = `${baseUrl}/projects/${projectId}/tasks/${taskId}`

    const page = volunteer.page
    await page.goto(taskUrl)
    await page.getByRole('button', { name: 'Offer to help' }).click()
    await expect(getAlert(page)).toContainText('Offer sent', { timeout: 10_000 })
    await expect(page.getByText("You've offered to help.")).toBeVisible()
    await expect(page.getByRole('button', { name: 'Withdraw request' })).toBeVisible()
    await snap(page, 'offer waiting')

    // One request, saying what it is for.
    await adminPage.goto(`${baseUrl}/projects/${projectId}#people`)
    const request = adminPage.locator('.interest-card').filter({ hasText: volunteer.name })
    await expect(
      request.getByRole('list', { name: `What ${volunteer.name} asks for` }),
    ).toContainText('Offers to help on Practise the briefing', { timeout: 10_000 })
    await snap(adminPage, 'request with its task')
    await request.getByRole('button', { name: 'Accept' }).click()
    await expect(getAlert(adminPage)).toContainText('Accepted. They', { timeout: 10_000 })

    await page.reload()
    await expect(
      page.getByRole('region', { name: 'Helpers' }).getByText('1 helper', { exact: true }),
    ).toBeVisible({ timeout: 10_000 })
    await expect(page.getByRole('button', { name: 'Withdraw from helping' })).toBeVisible()
    await expect(page.getByText("You've offered to help.")).toHaveCount(0)
  })

  test('a task asking for helpers is listed on Tasks, and offering from there opens it', async ({
    volunteer,
    baseUrl,
  }) => {
    const adminApi = createApiClient(baseUrl, readAdminToken(baseUrl))
    const projectId = await adminCreateProjectViaApi(
      baseUrl,
      fake.projectTitle(),
      'Helper places e2e project',
    )
    const title = fake.quickTaskTitle()
    const created = await adminApi.projects.createTask({ body: { projectId, title } })
    const taskId = (created.body as { id: number }).id
    await adminApi.projects.updateTask({ body: { projectId, taskId, data: { helpersWanted: 2 } } })

    const page = volunteer.page
    await page.goto(`${baseUrl}/tasks`)
    await page.getByRole('tab', { name: /^Open/ }).click()
    const card = page.getByRole('article').filter({ has: page.getByRole('link', { name: title }) })
    await expect(card).toContainText('2 helpers', { timeout: 10_000 })
    await card.getByRole('button', { name: 'Offer to help' }).click()
    await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/tasks/${taskId}$`))
    await expect(page.getByText("You've offered to help.")).toBeVisible({ timeout: 10_000 })
  })

  test('an admin puts a volunteer on fast track, who then starts helping straight away', async ({
    volunteer,
    adminPage,
    baseUrl,
  }) => {
    const adminApi = createApiClient(baseUrl, readAdminToken(baseUrl))
    const projectId = await adminCreateProjectViaApi(
      baseUrl,
      fake.projectTitle(),
      'Fast track e2e project',
    )
    const title = fake.quickTaskTitle()
    const created = await adminApi.projects.createTask({ body: { projectId, title } })
    const taskId = (created.body as { id: number }).id
    await adminApi.projects.updateTask({ body: { projectId, taskId, data: { helpersWanted: 1 } } })

    const page = volunteer.page
    await page.goto(`${baseUrl}/dashboard`)
    const token = await page.evaluate(() => localStorage.getItem('authToken'))
    const me = (await createApiClient(baseUrl, token).auth.me()).body as { id: number }

    await adminPage.goto(`${baseUrl}/volunteers/${me.id}`)
    await adminPage.getByRole('button', { name: `Fast track ${volunteer.name}` }).click()
    await expect(getAlert(adminPage)).toContainText('On fast track', { timeout: 10_000 })
    await expect(adminPage.getByRole('button', { name: 'Take off fast track' })).toBeVisible()

    // On fast track the task offers to join straight away rather than to ask.
    await page.goto(`${baseUrl}/projects/${projectId}/tasks/${taskId}`)
    await page.getByRole('button', { name: 'Join as helper' }).click()
    await expect(getAlert(page)).toContainText("You're helping on this task", { timeout: 10_000 })
    await expect(page.getByRole('button', { name: 'Withdraw from helping' })).toBeVisible()
  })
})
