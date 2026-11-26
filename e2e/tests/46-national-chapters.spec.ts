import {
  test,
  expect,
  getAlert,
  createApprovedVolunteer,
  createApprovedVolunteerNamed,
  signedInPage,
} from '../fixtures'
import { fake } from '../fake'
import { ensureChapter, makeChapterStaff } from '../actions/chapters'
import { selectFilterDropdown } from '../actions/ui'
import { adminCreateProjectViaApi } from '../actions/projects'

// Germany's chapter is this spec's alone.
const COUNTRY = 'Germany'

test.describe('National chapters', () => {
  test('A global admin appoints a lead, and the lead appoints a deputy', async ({
    adminPage,
    browser,
    baseUrl,
    snap,
  }) => {
    await ensureChapter(baseUrl, COUNTRY)
    const lead = await createApprovedVolunteer(baseUrl, { country: COUNTRY })
    const deputy = await createApprovedVolunteer(baseUrl, { country: COUNTRY })

    await adminPage.goto(`${baseUrl}/admin/chapters`)
    await adminPage.getByRole('link', { name: 'Germany', exact: true }).click()
    await expect(adminPage.getByRole('heading', { name: 'Germany chapter' })).toBeVisible({
      timeout: 10_000,
    })
    await selectFilterDropdown(adminPage, 'Appoint a lead', lead.name)
    await expect(getAlert(adminPage)).toContainText(`${lead.name} now leads the chapter`, {
      timeout: 10_000,
    })

    const leadPage = await signedInPage(browser, lead.token)
    try {
      await leadPage.goto(`${baseUrl}/admin`)
      await leadPage.getByRole('link', { name: 'Germany chapter' }).click()
      await expect(leadPage.getByRole('heading', { name: 'Germany chapter' })).toBeVisible({
        timeout: 10_000,
      })
      await selectFilterDropdown(leadPage, 'Appoint a deputy', deputy.name)
      await expect(getAlert(leadPage)).toContainText(`${deputy.name} is now a deputy`, {
        timeout: 10_000,
      })
      await expect(
        leadPage.getByRole('button', { name: `Remove ${deputy.name} as deputy` }),
      ).toBeVisible()
      await snap(leadPage, 'lead sees their deputy')
    } finally {
      await leadPage.context().close()
    }

    await adminPage.reload()
    await expect(adminPage.getByText(`appointed a deputy: ${deputy.name}`)).toBeVisible({
      timeout: 10_000,
    })
    await snap(adminPage, 'chapter history')
  })

  test('A global admin marks a second account as a duplicate, and it is no longer offered', async ({
    adminPage,
    baseUrl,
    snap,
  }) => {
    const chapterId = await ensureChapter(baseUrl, COUNTRY)
    const kept = await createApprovedVolunteer(baseUrl, { country: COUNTRY })
    const second = await createApprovedVolunteer(baseUrl, { country: COUNTRY })

    await adminPage.goto(`${baseUrl}/volunteers/${second.id}`)
    await expect(adminPage.getByText(second.email)).toBeVisible({ timeout: 10_000 })
    await snap(adminPage, 'profile as a global admin')
    await adminPage.getByRole('link', { name: 'Admin record' }).click()
    await expect(adminPage.getByRole('heading', { name: 'Duplicate accounts' })).toBeVisible({
      timeout: 10_000,
    })
    await selectFilterDropdown(adminPage, 'Mark as a duplicate of', kept.name)
    await snap(adminPage, 'account to keep chosen')
    await adminPage.getByRole('button', { name: 'Mark as duplicate' }).click()
    await expect(getAlert(adminPage)).toContainText(
      `${second.name} is marked as a duplicate of ${kept.name}`,
      { timeout: 10_000 },
    )
    await expect(adminPage.getByRole('button', { name: 'Not a duplicate' })).toBeVisible()
    await snap(adminPage, 'marked as a duplicate')

    await adminPage.goto(`${baseUrl}/volunteers/${second.id}`)
    await expect(adminPage.getByText('Duplicate account of')).toBeVisible({ timeout: 10_000 })
    await snap(adminPage, 'profile of a duplicate')

    await adminPage.goto(`${baseUrl}/admin/chapters/${chapterId}`)
    await expect(adminPage.getByText(`duplicate of ${kept.name}`)).toBeVisible({
      timeout: 10_000,
    })
    await adminPage.getByLabel('Appoint a lead', { exact: true }).click()
    const search = adminPage.getByRole('searchbox', { name: 'Appoint a lead' })
    await search.fill(kept.name)
    await expect(adminPage.getByRole('option', { name: kept.name, exact: true })).toBeVisible()
    await search.fill(second.name)
    await expect(adminPage.getByRole('option', { name: second.name, exact: true })).toHaveCount(0)
  })

  test('A global admin settles a pair of accounts with the same name', async ({
    adminPage,
    baseUrl,
    snap,
  }) => {
    const name = fake.personName()
    const kept = await createApprovedVolunteerNamed(baseUrl, name)
    const second = await createApprovedVolunteerNamed(baseUrl, name)

    await adminPage.goto(`${baseUrl}/admin`)
    await adminPage.getByRole('link', { name: /Possible duplicates/ }).click()
    await expect(adminPage.getByRole('heading', { name: 'Possible duplicates' })).toBeVisible({
      timeout: 10_000,
    })
    const keptAccount = adminPage.getByRole('group', { name: kept.email })
    await expect(keptAccount).toBeVisible({ timeout: 10_000 })
    await expect(adminPage.getByRole('group', { name: second.email })).toBeVisible()
    await snap(adminPage, 'a pair to settle')

    await keptAccount.getByRole('button', { name: 'Keep this account' }).click()
    await expect(getAlert(adminPage)).toContainText(`${name} is marked as a duplicate of ${name}`, {
      timeout: 10_000,
    })
    await expect(adminPage.getByRole('group', { name: kept.email })).toHaveCount(0)
  })

  test('A deputy runs the chapter but cannot appoint deputies', async ({ browser, baseUrl }) => {
    const chapterId = await ensureChapter(baseUrl, COUNTRY)
    const deputy = await createApprovedVolunteer(baseUrl, { country: COUNTRY })
    await makeChapterStaff(baseUrl, deputy.id, chapterId, 'DEPUTY')

    const page = await signedInPage(browser, deputy.token)
    try {
      await page.goto(`${baseUrl}/admin/chapters/${chapterId}`)
      await expect(page.getByRole('heading', { name: 'Germany chapter' })).toBeVisible({
        timeout: 10_000,
      })
      await expect(page.getByLabel('Appoint a deputy', { exact: true })).toHaveCount(0)
      await expect(page.getByRole('button', { name: 'Send invite' })).toHaveCount(0)
    } finally {
      await page.context().close()
    }
  })

  test("A chapter lead makes a member a deputy from the member's profile", async ({
    browser,
    baseUrl,
    snap,
  }) => {
    const chapterId = await ensureChapter(baseUrl, COUNTRY)
    const lead = await createApprovedVolunteer(baseUrl, { country: COUNTRY })
    await makeChapterStaff(baseUrl, lead.id, chapterId, 'LEAD')
    const member = await createApprovedVolunteer(baseUrl, { country: COUNTRY })

    const page = await signedInPage(browser, lead.token)
    try {
      await page.goto(`${baseUrl}/volunteers/${member.id}`)
      await page.getByRole('button', { name: 'Make chapter deputy' }).click({ timeout: 10_000 })
      const dialog = page.getByRole('dialog', {
        name: `Make ${member.name} a Germany chapter deputy?`,
      })
      await snap(page, 'make chapter deputy dialog')
      await dialog.getByRole('button', { name: 'Make chapter deputy' }).click()
      await expect(getAlert(page)).toContainText(`${member.name} is now a deputy`, {
        timeout: 10_000,
      })
      await expect(page.getByRole('button', { name: 'Remove as chapter deputy' })).toBeVisible()
      // The member's history, in the Manage panel, says who did it.
      await page.getByText('History', { exact: true }).click()
      await expect(page.getByText(/made them a deputy of the Germany chapter/)).toBeVisible({
        timeout: 10_000,
      })
      await snap(page, 'member history')

      await page.goto(`${baseUrl}/admin`)
      await page.getByRole('link', { name: 'Germany chapter: deputies and members' }).click()
      await expect(
        page.getByRole('button', { name: `Remove ${member.name} as deputy` }),
      ).toBeVisible({ timeout: 10_000 })
    } finally {
      await page.context().close()
    }
  })

  test("A global admin makes a member the chapter's lead from the member's profile", async ({
    adminPage,
    baseUrl,
    snap,
  }) => {
    await ensureChapter(baseUrl, COUNTRY)
    const member = await createApprovedVolunteer(baseUrl, { country: COUNTRY })

    await adminPage.goto(`${baseUrl}/volunteers/${member.id}`)
    const panel = adminPage.getByRole('region', { name: 'Manage' })
    await expect(panel.getByRole('link', { name: 'Admin record' })).toBeVisible({
      timeout: 10_000,
    })
    await snap(adminPage, 'manage panel as a global admin')
    await panel.getByRole('button', { name: 'Make chapter lead' }).click()
    const dialog = adminPage.getByRole('dialog', {
      name: `Make ${member.name} lead of the Germany chapter?`,
    })
    await dialog.getByRole('button', { name: 'Make chapter lead' }).click()
    await expect(getAlert(adminPage)).toContainText(`${member.name} now leads the chapter`, {
      timeout: 10_000,
    })
    await expect(panel.getByRole('button', { name: 'Remove as chapter lead' })).toBeVisible({
      timeout: 10_000,
    })
  })

  test('A global admin makes a member a coordinator, then moves them to the pool, from their profile', async ({
    adminPage,
    baseUrl,
    snap,
  }) => {
    await ensureChapter(baseUrl, COUNTRY)
    const member = await createApprovedVolunteer(baseUrl, { country: COUNTRY })

    await adminPage.goto(`${baseUrl}/volunteers/${member.id}`)
    const panel = adminPage.getByRole('region', { name: 'Manage' })
    await panel.getByRole('button', { name: 'Make coordinator' }).click({ timeout: 10_000 })
    const appoint = adminPage.getByRole('dialog', { name: `Make ${member.name} a coordinator?` })
    await appoint.getByLabel(/What they coordinate/).fill('Media')
    await snap(adminPage, 'make coordinator dialog')
    await appoint.getByRole('button', { name: 'Make coordinator' }).click()
    await expect(getAlert(adminPage)).toContainText(`${member.name} is a coordinator`, {
      timeout: 10_000,
    })
    await expect(panel.getByRole('button', { name: 'Remove as coordinator' })).toBeVisible({
      timeout: 10_000,
    })

    await panel.getByRole('button', { name: 'Move to another chapter' }).click()
    const move = adminPage.getByRole('dialog', {
      name: `Move ${member.name} to another chapter?`,
    })
    await move.getByLabel('Move to').selectOption('pool')
    await snap(adminPage, 'move chapter dialog')
    await move.getByRole('button', { name: 'Move' }).click()
    await expect(getAlert(adminPage)).toContainText('Moved', { timeout: 10_000 })
    await expect(adminPage.getByText('No national chapter yet')).toBeVisible({ timeout: 10_000 })
  })

  test("A chapter lead signs a member out on every device from the member's profile", async ({
    browser,
    baseUrl,
    snap,
  }) => {
    const chapterId = await ensureChapter(baseUrl, COUNTRY)
    const lead = await createApprovedVolunteer(baseUrl, { country: COUNTRY })
    await makeChapterStaff(baseUrl, lead.id, chapterId, 'LEAD')
    const member = await createApprovedVolunteer(baseUrl, { country: COUNTRY })

    const memberPage = await signedInPage(browser, member.token)
    const leadPage = await signedInPage(browser, lead.token)
    try {
      await memberPage.goto(`${baseUrl}/dashboard`)
      await leadPage.goto(`${baseUrl}/volunteers/${member.id}`)
      await leadPage.getByRole('button', { name: 'Sign out everywhere' }).click({ timeout: 10_000 })
      await snap(leadPage, 'sign out everywhere dialog')
      await leadPage
        .getByRole('dialog', { name: `Sign ${member.name} out everywhere?` })
        .getByRole('button', { name: 'Sign out everywhere' })
        .click()
      await expect(getAlert(leadPage)).toContainText(`${member.name} is signed out everywhere`, {
        timeout: 10_000,
      })

      await memberPage.reload()
      await expect(memberPage).toHaveURL(/\/login/, { timeout: 10_000 })
    } finally {
      await memberPage.context().close()
      await leadPage.context().close()
    }
  })

  test('A chapter lead suspends a member, who is signed out and cannot sign back in', async ({
    browser,
    baseUrl,
    snap,
  }) => {
    const chapterId = await ensureChapter(baseUrl, COUNTRY)
    const lead = await createApprovedVolunteer(baseUrl, { country: COUNTRY })
    await makeChapterStaff(baseUrl, lead.id, chapterId, 'LEAD')
    const member = await createApprovedVolunteer(baseUrl, { country: COUNTRY })

    const memberPage = await signedInPage(browser, member.token)
    const leadPage = await signedInPage(browser, lead.token)
    try {
      await memberPage.goto(`${baseUrl}/dashboard`)
      await leadPage.goto(`${baseUrl}/volunteers/${member.id}`)
      await leadPage.getByRole('button', { name: 'Suspend' }).click({ timeout: 10_000 })
      const dialog = leadPage.getByRole('dialog', { name: `Suspend ${member.name}?` })
      await dialog.getByLabel(/Why/).fill('Repeated spam in messages')
      await snap(leadPage, 'suspend dialog')
      await dialog.getByRole('button', { name: 'Suspend' }).click()
      await expect(getAlert(leadPage)).toContainText(`${member.name} is suspended`, {
        timeout: 10_000,
      })
      await expect(leadPage.getByText(/Repeated spam in messages/)).toBeVisible({
        timeout: 10_000,
      })

      await memberPage.reload()
      await expect(memberPage).toHaveURL(/\/login/, { timeout: 10_000 })
      await memberPage.getByLabel('Email', { exact: true }).fill(member.email)
      await memberPage.getByLabel('Password').fill('testpassword1')
      await memberPage.getByRole('button', { name: 'Login' }).click()
      await expect(memberPage.getByText(/This account is suspended/)).toBeVisible({
        timeout: 10_000,
      })
    } finally {
      await memberPage.context().close()
      await leadPage.context().close()
    }
  })

  test('A chapter lead asks another chapter to take a member, and its lead accepts', async ({
    browser,
    baseUrl,
    snap,
  }) => {
    const chapterId = await ensureChapter(baseUrl, COUNTRY)
    // Austria's chapter is this test's alone.
    const otherId = await ensureChapter(baseUrl, 'Austria')
    const lead = await createApprovedVolunteer(baseUrl, { country: COUNTRY })
    await makeChapterStaff(baseUrl, lead.id, chapterId, 'LEAD')
    const otherLead = await createApprovedVolunteer(baseUrl, { country: 'Austria' })
    await makeChapterStaff(baseUrl, otherLead.id, otherId, 'LEAD')
    const member = await createApprovedVolunteer(baseUrl, { country: COUNTRY })

    const page = await signedInPage(browser, lead.token)
    const otherPage = await signedInPage(browser, otherLead.token)
    try {
      await page.goto(`${baseUrl}/volunteers/${member.id}`)
      await page
        .getByRole('button', { name: 'Ask to move to another chapter' })
        .click({ timeout: 10_000 })
      const dialog = page.getByRole('dialog', { name: `Move ${member.name} on?` })
      await dialog.getByLabel('Move to').selectOption({ label: 'Austria' })
      await snap(page, 'ask to move dialog')
      await dialog.getByRole('button', { name: 'Ask' }).click()
      await expect(page.getByText(/Waiting: a move from Germany to Austria/)).toBeVisible({
        timeout: 10_000,
      })

      await otherPage.goto(`${baseUrl}/admin/transfers`)
      await expect(otherPage.getByText(/asked you to take them/)).toBeVisible({ timeout: 10_000 })
      await otherPage.getByRole('button', { name: `Approve move for ${member.name}` }).click()
      await expect(getAlert(otherPage)).toContainText('Moved', { timeout: 10_000 })

      // Austria's lead now runs them; Germany's lead no longer does.
      await otherPage.goto(`${baseUrl}/volunteers/${member.id}`)
      await expect(otherPage.getByText(/Austria chapter/).first()).toBeVisible({ timeout: 10_000 })
    } finally {
      await page.context().close()
      await otherPage.context().close()
    }
  })

  test('A chapter lead invites someone already in another chapter, and asks to bring them in', async ({
    browser,
    baseUrl,
    snap,
  }) => {
    const chapterId = await ensureChapter(baseUrl, COUNTRY)
    // Austria's chapter is this spec's, shared only with the move above.
    await ensureChapter(baseUrl, 'Austria')
    const lead = await createApprovedVolunteer(baseUrl, { country: COUNTRY })
    await makeChapterStaff(baseUrl, lead.id, chapterId, 'LEAD')
    const elsewhere = await createApprovedVolunteer(baseUrl, { country: 'Austria' })

    const page = await signedInPage(browser, lead.token)
    try {
      await page.goto(`${baseUrl}/admin/chapters/${chapterId}`)
      const section = page.getByRole('region', { name: 'Invite someone to join' })
      await section.getByLabel('Their email').fill(elsewhere.email, { timeout: 10_000 })
      await section.getByRole('button', { name: 'Invite to join' }).click()
      await expect(section.getByRole('status')).toContainText(
        `${elsewhere.name} is already on Action Hub, in the Austria chapter.`,
        { timeout: 10_000 },
      )
      await snap(page, 'invite finds someone in another chapter')
      await section
        .getByRole('button', { name: `Ask to bring ${elsewhere.name} into Germany` })
        .click()
      await expect(getAlert(page)).toContainText(
        `Asked: Germany's move for ${elsewhere.name} is waiting for an answer`,
        { timeout: 10_000 },
      )
    } finally {
      await page.context().close()
    }
  })

  test("A chapter lead verifies a member's skill and invites them to a project from their profile", async ({
    browser,
    baseUrl,
    snap,
  }) => {
    const chapterId = await ensureChapter(baseUrl, COUNTRY)
    const lead = await createApprovedVolunteer(baseUrl, { country: COUNTRY })
    await makeChapterStaff(baseUrl, lead.id, chapterId, 'LEAD')
    const member = await createApprovedVolunteer(baseUrl, { country: COUNTRY })
    const title = fake.projectTitle()
    await adminCreateProjectViaApi(baseUrl, title, 'Invite from a profile', { chapterId })

    const page = await signedInPage(browser, lead.token)
    try {
      await page.goto(`${baseUrl}/volunteers/${member.id}`)
      const panel = page.getByRole('region', { name: 'Manage' })
      await panel.getByRole('button', { name: 'Verify a skill' }).click({ timeout: 10_000 })
      const verify = page.getByRole('dialog', { name: `Verify one of ${member.name}'s skills` })
      const skill = verify.getByLabel('Skill')
      await expect(skill.locator('option')).not.toHaveCount(1, { timeout: 10_000 })
      await skill.selectOption({ index: 1 })
      await snap(page, 'verify a skill dialog')
      await verify.getByRole('button', { name: 'Verify skill' }).click()
      await expect(getAlert(page)).toContainText('Skill endorsed', { timeout: 10_000 })

      await panel.getByRole('button', { name: 'Invite to a project' }).click()
      const invite = page.getByRole('dialog', { name: `Invite ${member.name} to a project` })
      await invite.getByLabel('Project').selectOption({ label: title })
      await invite.getByLabel('Note (optional)').fill('We could use you here')
      await snap(page, 'invite to a project dialog')
      await invite.getByRole('button', { name: 'Send invite' }).click()
      await expect(getAlert(page)).toContainText('Invite sent', { timeout: 10_000 })
    } finally {
      await page.context().close()
    }
  })

  test("A member sees no Manage panel on a fellow member's profile", async ({
    browser,
    baseUrl,
  }) => {
    await ensureChapter(baseUrl, COUNTRY)
    const member = await createApprovedVolunteer(baseUrl, { country: COUNTRY })
    const other = await createApprovedVolunteer(baseUrl, { country: COUNTRY })
    const page = await signedInPage(browser, other.token)
    try {
      await page.goto(`${baseUrl}/volunteers/${member.id}`)
      await expect(page.getByRole('heading', { name: member.name })).toBeVisible({
        timeout: 10_000,
      })
      await expect(page.getByRole('region', { name: 'Manage' })).toHaveCount(0)
    } finally {
      await page.context().close()
    }
  })

  test('A global admin asks two look-alike accounts to prove they are one person', async ({
    adminPage,
    baseUrl,
    snap,
  }) => {
    await ensureChapter(baseUrl, COUNTRY)
    const name = fake.person().name
    await createApprovedVolunteerNamed(baseUrl, name)
    const second = await createApprovedVolunteerNamed(baseUrl, name)

    await adminPage.goto(`${baseUrl}/volunteers/${second.id}`)
    await adminPage
      .getByRole('button', { name: 'Merge with another account' })
      .click({ timeout: 10_000 })
    const dialog = adminPage.getByRole('dialog', { name: `Merge ${name}'s account with another?` })
    await dialog.getByRole('radio', { name: /needs proof first/ }).check({ timeout: 10_000 })
    await snap(adminPage, 'merge accounts dialog')
    await dialog.getByRole('button', { name: 'Ask for proof' }).click()
    await expect(getAlert(adminPage)).toContainText(`Sent ${name} a link at each address`, {
      timeout: 10_000,
    })
    await expect(adminPage.getByText(/^Waiting: merging/)).toContainText(
      'until the links sent to both addresses are followed.',
      { timeout: 10_000 },
    )
  })

  test("A chapter lead is turned away from another chapter's page", async ({
    browser,
    baseUrl,
  }) => {
    const chapterId = await ensureChapter(baseUrl, COUNTRY)
    const lead = await createApprovedVolunteer(baseUrl, { country: COUNTRY })
    await makeChapterStaff(baseUrl, lead.id, chapterId, 'LEAD')
    const ukChapterId = await ensureChapter(baseUrl, 'UK')

    const page = await signedInPage(browser, lead.token)
    try {
      await page.goto(`${baseUrl}/admin/chapters/${ukChapterId}`)
      await expect(page.getByRole('heading', { name: 'Chapter not found' })).toBeVisible({
        timeout: 10_000,
      })
    } finally {
      await page.context().close()
    }
  })
})
