import type { Page } from '@playwright/test'
import { test, expect, readAdminToken } from '../fixtures'
import { adminCreateProjectViaApi } from '../actions/projects'
import { createApiClient } from '../client'
import { fake } from '../fake'

// On a phone, cards run edge to edge by pulling out through the page gutter; one that pulls
// further than its gutter makes the whole page scroll sideways.
const PHONE = { width: 390, height: 844 }

async function expectNoSidewaysScroll(page: Page, url: string): Promise<void> {
  await page.goto(url)
  await page.waitForLoadState('networkidle')
  const { scrollWidth, innerWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }))
  expect(scrollWidth, url).toBeLessThanOrEqual(innerWidth)
}

// The 16px floor in globals.css.
async function expectNoZoomingFields(page: Page, url: string): Promise<void> {
  if (page.url() !== url) await page.goto(url)
  await page.waitForLoadState('networkidle')
  const fields = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('input, textarea, select')]
      .filter(
        (el) => !['checkbox', 'radio', 'file', 'hidden'].includes((el as HTMLInputElement).type),
      )
      .filter((el) => el.offsetParent !== null)
      .map((el) => ({
        field: el.id || el.outerHTML.slice(0, 80),
        px: parseFloat(getComputedStyle(el).fontSize),
      })),
  )
  expect(fields.length, `${url} has a field to check`).toBeGreaterThan(0)
  expect(
    fields.filter((f) => f.px < 16),
    url,
  ).toEqual([])
}

test.describe('Phone layout', () => {
  test('no page scrolls sideways at phone width', async ({ adminPage, browser, baseUrl }) => {
    const adminApi = createApiClient(baseUrl, readAdminToken(baseUrl))
    const projectId = await adminCreateProjectViaApi(
      baseUrl,
      fake.projectTitle(),
      'A project to lay out on a phone',
    )
    const task = await adminApi.projects.createTask({
      body: { projectId, title: 'A task to lay out on a phone' },
    })
    expect(task.status).toBe(200)
    const taskId = (task.body as { id: number }).id

    await adminPage.setViewportSize(PHONE)
    for (const path of [
      '/dashboard',
      '/projects',
      `/projects/${projectId}`,
      `/projects/${projectId}#people`,
      `/projects/${projectId}/tasks/${taskId}`,
      '/tasks',
      '/volunteers',
      '/inbox',
      '/settings',
      '/templates',
      '/suggest',
      '/admin',
      '/admin/projects',
    ]) {
      await expectNoSidewaysScroll(adminPage, `${baseUrl}${path}`)
    }

    const anon = await browser.newPage({ viewport: PHONE })
    for (const path of ['/', '/login', '/signup', '/forgot-password']) {
      await expectNoSidewaysScroll(anon, `${baseUrl}${path}`)
    }
    await anon.close()
  })

  test('no text field is small enough for a phone to zoom in on it', async ({
    adminPage,
    volunteer,
    browser,
    baseUrl,
  }) => {
    const projectId = await adminCreateProjectViaApi(
      baseUrl,
      fake.projectTitle(),
      'A project to import into on a phone',
    )
    await adminPage.setViewportSize(PHONE)
    for (const path of ['/settings', `/projects/${projectId}/import`]) {
      await expectNoZoomingFields(adminPage, `${baseUrl}${path}`)
    }

    const outreach = `${baseUrl}/people-for-a-pause-protest-journalist-outreach`
    await volunteer.page.setViewportSize(PHONE)
    await volunteer.page.goto(outreach)
    await volunteer.page.getByRole('button', { name: `Continue as ${volunteer.email}` }).click()
    await expect(volunteer.page.getByLabel('Your phone number (optional)')).toBeVisible({
      timeout: 10_000,
    })
    await expectNoZoomingFields(volunteer.page, outreach)

    const context = await browser.newContext({ viewport: PHONE, isMobile: true, hasTouch: true })
    const anon = await context.newPage()
    for (const path of ['/login', '/signup', '/forgot-password', '/verify-email']) {
      await expectNoZoomingFields(anon, `${baseUrl}${path}`)
    }
    await context.close()
  })
})
