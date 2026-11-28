import { test, expect } from '../fixtures'
import { createApprovedVolunteerNamed, readAdminToken, signedInPage } from '../fixtures'
import { createApiClient } from '../client'
import { fake } from '../fake'

// The lead, named by a global admin, adds a member and a call; the member takes it and says
// they're on. Every other path is a router or page test.
test.describe('Global Onboarding', () => {
  test('The lead adds a call and a member, who hosts it', async ({ browser, baseUrl, snap }) => {
    const adminApi = createApiClient(baseUrl, readAdminToken(baseUrl))
    const lead = await createApprovedVolunteerNamed(baseUrl, fake.personName())
    const member = await createApprovedVolunteerNamed(baseUrl, fake.personName())
    expect((await adminApi.onboarding.setLead({ body: { email: lead.email } })).status).toBe(200)
    const callName = fake.projectTitle()

    const leading = await signedInPage(browser, lead.token)
    await leading.goto(`${baseUrl}/onboarding`)
    await expect(leading.getByRole('heading', { name: 'Global Onboarding' })).toBeVisible()
    await leading.getByLabel('Add someone by their Action Hub email').fill(member.email)
    await leading.getByRole('button', { name: 'Add to team' }).click()
    await expect(leading.getByText(`${member.name} is on the team`)).toBeVisible()

    const add = leading.getByRole('form', { name: 'Add a call' })
    await add.getByLabel('Name').fill(callName)
    await add.getByLabel('When (UTC)').fill('2099-03-04T14:00')
    await add.getByRole('button', { name: 'Add call' }).click()
    const call = leading.getByRole('region', { name: new RegExp(callName) })
    await expect(call.getByText('Needs a host')).toBeVisible()
    await snap(leading, 'lead view')

    const hosting = await signedInPage(browser, member.token)
    await hosting.goto(`${baseUrl}/onboarding`)
    const theirs = hosting.getByRole('region', { name: new RegExp(callName) })
    await expect(theirs.getByText('Needs a host')).toBeVisible()
    await expect(hosting.getByRole('form', { name: 'Add a call' })).toHaveCount(0)
    await theirs.getByRole('button', { name: "I'll host" }).click()
    await expect(theirs.getByText('Not confirmed yet')).toBeVisible()
    await theirs.getByRole('button', { name: "I'm on" }).click()
    await expect(theirs.getByText('Confirmed')).toBeVisible()
    await snap(hosting, 'member hosting')

    await leading.reload()
    await expect(call.getByLabel('Host')).toHaveValue(String(member.id))
  })

  test('Someone off the team is turned away', async ({ browser, baseUrl }) => {
    const outsider = await createApprovedVolunteerNamed(baseUrl, fake.personName())
    const page = await signedInPage(browser, outsider.token)
    await page.goto(`${baseUrl}/onboarding`)
    await expect(page).toHaveURL(/\/projects/)
    await expect(page.getByRole('heading', { name: 'Global Onboarding' })).toHaveCount(0)
  })
})
