import { describe, it, expect } from 'vitest'
import { screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { prisma } from '@/lib/prisma'
import {
  createChapter,
  createMember,
  createChapterLead,
  createChapterDeputy,
  createCoordinator,
  connect,
  createVolunteer,
  createAdmin,
  createProject,
  createTask,
  createQuickTask,
  createSkill,
  createLocalGroup,
  chapterFor,
} from '@/test/factories'
import { renderApp } from '@/test/render'
import { queryClient } from '@/lib/query-client'
import { navigation } from '@/test/next-navigation'
import { emails } from '@/test/fakes/email'
import VolunteersPage from './page'
import VolunteerDetailPage from './[id]/page'

describe('volunteer directory', () => {
  it('lists, filters, pages and clears', async () => {
    const skill = await createSkill()
    const extra = await Promise.all(Array.from({ length: 6 }, () => createSkill()))
    const chapter = await createChapter()
    const dirTown = await createLocalGroup({
      name: 'Dir Town',
      country: chapter.country,
      nationalChapterId: chapter.id,
    })
    const me = await createMember(chapter)
    const ann = await createMember(chapter, {
      name: 'Ann Directory',
      bio: 'x'.repeat(120),
      localGroupId: dirTown.id,
      availabilityHoursPerWeek: 4,
      skills: { create: [skill, ...extra].map((s) => ({ skillId: s.id })) },
    })
    await createMember(chapter, {
      name: 'Hidden Person',
      consentMakeProfileVisibleInDirectory: false,
    })
    for (let i = 0; i < 50; i++)
      await createMember(chapter, {
        name: `Filler ${i}`,
        bio: null,
        availabilityHoursPerWeek: null,
        location: 'Somewhere',
      })
    await renderApp(<VolunteersPage />, { as: me, url: '/volunteers' })
    await screen.findByText('Page 1 of 2')
    await userEvent.click(screen.getByRole('button', { name: 'Next' }))
    await screen.findByText('Page 2 of 2')
    await userEvent.click(screen.getByRole('button', { name: 'Previous' }))
    await screen.findByText('Page 1 of 2')
    await userEvent.click(screen.getByRole('button', { name: 'Skill filter' }))
    await userEvent.click(await screen.findByRole('option', { name: skill.name }))
    await screen.findByRole('link', { name: 'Ann Directory' })
    // Rows are compact: the first three skills, and a way to reach them.
    expect(screen.getByText('and 4 more')).toBeInTheDocument()
    const annCard = screen
      .getByRole('link', { name: 'Ann Directory' })
      .closest('.card') as HTMLElement
    expect(within(annCard).getByRole('button', { name: 'Request contact' })).toBeInTheDocument()
    expect(screen.getByText(new RegExp(`📍 Dir Town · ${chapter.name}`))).toBeInTheDocument()
    expect(screen.getByText('🕐 4h/week')).toBeInTheDocument()
    expect(screen.queryByText('Filler 0')).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'Local group filter' }))
    await userEvent.click(await screen.findByRole('option', { name: 'Dir Town' }))
    await screen.findByRole('link', { name: 'Ann Directory' })
    fireEvent.change(screen.getByLabelText('Search'), { target: { value: 'nobody-matches' } })
    await screen.findByText('No volunteers found')
    await userEvent.click(screen.getByRole('button', { name: 'Clear filters' }))
    expect(navigation.replace).toHaveBeenCalledWith('?', { scroll: false })
    expect(screen.queryByText('Hidden Person')).toBeNull()
    expect(screen.queryByText(ann.email!)).toBeNull()

    cleanup()
    const admin = await createAdmin()
    await renderApp(<VolunteersPage />, { as: admin, url: '/volunteers?q=Hidden' })
    const hiddenCard = (await screen.findByRole('link', { name: 'Hidden Person' })).closest(
      '.card',
    ) as HTMLElement
    expect(screen.getByText('Hidden')).toBeInTheDocument()
    expect(within(hiddenCard).getByText(/@/)).toBeInTheDocument()
    // A global admin narrows the directory to a chapter, then to one of its groups.
    await userEvent.click(screen.getByRole('button', { name: 'Chapter filter' }))
    await userEvent.click(await screen.findByRole('option', { name: 'Holding pool' }))
    await screen.findByText('No volunteers found')
    await userEvent.click(screen.getByRole('button', { name: 'Chapter filter' }))
    await userEvent.click(await screen.findByRole('option', { name: chapter.name }))
    await screen.findByRole('link', { name: 'Hidden Person' })
    expect(await screen.findByRole('button', { name: 'Local group filter' })).toBeInTheDocument()
  })

  it('keeps a duplicate account listed, marked for a global admin', async () => {
    const kept = await createVolunteer({ name: 'Dupe Kept' })
    await createVolunteer({ name: 'Dupe Old', duplicateOfId: kept.id })
    await renderApp(<VolunteersPage />, { as: await createAdmin(), url: '/volunteers?q=Dupe' })
    const oldCard = (await screen.findByRole('link', { name: 'Dupe Old' })).closest(
      '.card',
    ) as HTMLElement
    expect(within(oldCard).getByText(/Duplicate account of/)).toBeInTheDocument()
    expect(within(oldCard).getByRole('link', { name: 'Dupe Kept' })).toHaveAttribute(
      'href',
      `/volunteers/${kept.id}`,
    )
    expect(screen.getAllByText(/Duplicate account of/)).toHaveLength(1)
  })
})

describe('volunteer profile', () => {
  it('shows a full profile with contact, endorsements, tasks and history', async () => {
    const me = await createAdmin()
    const skill = await createSkill()
    const vol = await createVolunteer({
      name: 'Profiled',
      email: 'profiled@example.org',
      location: 'Leeds',
      nationalChapterId: (await chapterFor('UK')).id,
      localGroupId: (await createLocalGroup({ name: 'North' })).id,
      otherSkills: 'juggling',
      availabilityHoursPerWeek: 3,
      discordHandle: 'd#1',
      signalNumber: '+1',
      whatsappNumber: '+2',
      contactNotes: 'evenings',
      skills: { create: [{ skillId: skill.id }] },
    })
    await prisma.skillEndorsement.create({
      data: {
        volunteerId: vol.id,
        skillId: skill.id,
        endorsedById: me.id,
        rating: 'strong',
        createdAt: new Date(Date.UTC(2026, 3, 4, 12)),
        notes: 'Private review notes',
      },
    })
    const unlisted = await createSkill({ name: 'Unlisted but verified' })
    await prisma.skillEndorsement.create({
      data: {
        volunteerId: vol.id,
        skillId: unlisted.id,
        endorsedById: me.id,
        source: 'quick_task',
        createdAt: null,
      },
    })
    const developing = await createSkill({ name: 'Still developing' })
    await prisma.skillEndorsement.create({
      data: {
        volunteerId: vol.id,
        skillId: developing.id,
        endorsedById: (await createVolunteer({ deletedAt: new Date() })).id,
        rating: 'developing',
        source: 'project_outcome',
        createdAt: null,
      },
    })
    const plain = await createSkill({ name: 'Unverified skill' })
    await prisma.volunteerSkill.create({ data: { volunteerId: vol.id, skillId: plain.id } })
    await createQuickTask({
      title: 'Done task',
      assigneeId: vol.id,
      status: 'completed',
      reviewRating: 'good',
      skillId: skill.id,
    })
    await createQuickTask({
      title: 'Plain task',
      assigneeId: vol.id,
      status: 'completed',
      reviewRating: 'excellent',
    })
    await createProject({ title: 'Led', assigneeId: vol.id })
    await createProject({ title: 'Pitched', creatorId: vol.id })
    const finished = await createProject({
      title: 'Finished',
      status: 'completed',
      completedAt: new Date(Date.UTC(2026, 2, 9, 12)),
    })
    await prisma.workItemInterest.create({
      data: {
        workItemId: finished.id,
        volunteerId: vol.id,
        interestType: 'want_to_contribute',
        status: 'accepted',
        respondedAt: new Date(Date.UTC(2026, 1, 2, 12)),
      },
    })
    const task = await createTask(finished.id, {
      title: 'Wrote the copy',
      status: 'completed',
      assigneeId: vol.id,
      claimedAt: new Date(Date.UTC(2026, 1, 3, 12)),
      completedAt: new Date(Date.UTC(2026, 2, 1, 12)),
    })
    await renderApp(<VolunteerDetailPage params={Promise.resolve({ id: String(vol.id) })} />, {
      as: me,
    })
    await screen.findByRole('heading', { name: 'Profiled' })
    const place = document.getElementById('volunteerPlace') as HTMLElement
    expect(within(place).getByText('🇬🇧 United Kingdom chapter')).toBeInTheDocument()
    expect(within(place).getByText('👥 North')).toBeInTheDocument()
    expect(within(place).getByText('📍 Leeds')).toBeInTheDocument()
    // Endorsed skills are marked in the skills list, with who endorsed them on hover.
    const skillList = document.getElementById('volunteerSkills') as HTMLElement
    expect(within(skillList).getByText('Unverified skill')).toHaveTextContent(/^Unverified skill$/)
    const strong = within(skillList).getByText(skill.name)
    await userEvent.hover(strong)
    expect(screen.getByRole('tooltip')).toHaveTextContent(
      `Verified as strong by ${me.name} from direct observation, 4 April 2026`,
    )
    expect(screen.getByRole('tooltip')).not.toHaveTextContent('Private review notes')
    await userEvent.unhover(strong)
    expect(within(skillList).getByText('Unlisted but verified').parentElement).toHaveTextContent(
      `(verified: Verified by ${me.name} for a reviewed quick task)`,
    )
    // Rated only as developing: not marked verified, and a deleted endorser is not named.
    expect(within(skillList).getByText('Still developing').parentElement).toHaveTextContent(
      /^Still developing\(rated: Rated as developing for delivering a project\)$/,
    )
    expect(screen.queryByText('Verified skills')).toBeNull()
    expect(screen.getByText('juggling')).toBeInTheDocument()
    expect(screen.getByText('3 hours/week')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'profiled@example.org' })).toHaveAttribute(
      'href',
      'mailto:profiled@example.org',
    )
    expect(screen.getByRole('link', { name: 'Admin record' })).toHaveAttribute(
      'href',
      `/admin/volunteers/${vol.id}`,
    )
    expect(screen.queryByText(/Duplicate account of/)).toBeNull()
    expect(screen.getByText('Discord: d#1')).toBeInTheDocument()
    expect(screen.getByText('evenings')).toBeInTheDocument()
    expect(screen.getByText('Done task')).toBeInTheDocument()
    const current = screen.getByRole('list', { name: 'Current projects' })
    expect(within(current).getByRole('link', { name: 'Led' })).toBeInTheDocument()
    expect(within(current).getByText('Owner')).toBeInTheDocument()
    const past = screen.getByRole('list', { name: 'Past projects' })
    expect(within(past).getByRole('link', { name: 'Pitched' })).toBeInTheDocument()
    expect(within(past).getByText(/^Creator from /)).toBeInTheDocument()
    expect(
      within(past).getByText('Member from 2 Feb 2026 · Finished 9 Mar 2026'),
    ).toBeInTheDocument()
    const tasks = within(past).getByRole('list', { name: 'Tasks on Finished' })
    expect(within(tasks).getByRole('link', { name: 'Wrote the copy' })).toHaveAttribute(
      'href',
      `/projects/${finished.id}/tasks/${task.id}`,
    )
    expect(
      within(tasks).getByText('Assignee from 3 Feb 2026 · finished 1 Mar 2026'),
    ).toBeInTheDocument()
  })

  it('offers a message to someone the viewer is connected with, and themselves an edit link instead', async () => {
    const me = await createVolunteer({ name: 'Sender' })
    const vol = await createVolunteer({
      name: 'Reachable',
      email: 'reachable@example.org',
      lastActiveAt: new Date(),
    })
    await connect(me, vol)
    await renderApp(<VolunteerDetailPage params={Promise.resolve({ id: String(vol.id) })} />, {
      as: me,
    })
    await screen.findByRole('heading', { name: 'Reachable' })
    expect(screen.queryByRole('link', { name: 'Edit profile' })).toBeNull()
    await userEvent.click(await screen.findByRole('button', { name: 'Message' }))
    const dialog = screen.getByRole('dialog', { name: 'Message Reachable' })
    expect(dialog).toHaveTextContent(
      'Reachable will see this in their Inbox and get a copy by email.',
    )
    await userEvent.type(within(dialog).getByLabelText('Subject'), 'Hello')
    await userEvent.type(within(dialog).getByLabelText('Message'), 'Can we talk?')
    // Sharing my address lets them reply to the email itself.
    await userEvent.click(within(dialog).getByLabelText(/Let Reachable reply by email/))
    await userEvent.click(within(dialog).getByRole('button', { name: 'Send message' }))
    await screen.findByText(/Message sent\./)
    expect(screen.queryByRole('dialog')).toBeNull()
    await waitFor(() =>
      expect(emails.lastTo('reachable@example.org')?.html).toContain('Can we talk?'),
    )
    expect(emails.lastTo('reachable@example.org')?.replyTo).toBe(me.email)
    expect(
      await prisma.message.findFirstOrThrow({ where: { toVolunteerId: vol.id } }),
    ).toMatchObject({ fromVolunteerId: me.id, subject: 'Hello', relatedWorkItemId: null })

    // Cancel closes without sending.
    await userEvent.click(screen.getByRole('button', { name: 'Message' }))
    await userEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }),
    )
    expect(screen.queryByRole('dialog')).toBeNull()
    cleanup()

    await renderApp(<VolunteerDetailPage params={Promise.resolve({ id: String(vol.id) })} />, {
      as: vol,
    })
    await screen.findByRole('heading', { name: 'Reachable' })
    expect(screen.getByRole('img', { name: 'Active in the last 14 days' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Message' })).toBeNull()
    expect(screen.getByRole('link', { name: 'Edit profile' })).toHaveAttribute(
      'href',
      '/settings?tab=profile',
    )
  })

  it('answers a contact request from the profile, and says when there is no way in', async () => {
    const me = await createVolunteer()
    const asker = await createVolunteer({ name: 'Asker' })
    const other = await createVolunteer({ name: 'Other Asker' })
    for (const from of [asker, other]) {
      await prisma.contactRequest.create({
        data: {
          fromVolunteerId: from.id,
          toVolunteerId: me.id,
          message: 'See https://example.org/plan',
        },
      })
    }
    const view = (id: number) =>
      renderApp(<VolunteerDetailPage params={Promise.resolve({ id: String(id) })} />, { as: me })
    await view(asker.id)
    const banner = await screen.findByRole('region', { name: 'Contact request' })
    expect(within(banner).getByRole('link', { name: 'https://example.org/plan' })).toBeTruthy()
    await userEvent.click(within(banner).getByRole('button', { name: 'Accept' }))
    await screen.findByText('Connected. You can now message each other.')
    await screen.findByRole('button', { name: 'Message' })
    cleanup()

    await view(other.id)
    const second = await screen.findByRole('region', { name: 'Contact request' })
    await userEvent.click(within(second).getByRole('button', { name: 'Decline' }))
    await screen.findByText('Request declined. They are not told.')
    cleanup()

    // The request has gone by the time it is answered.
    const late = await createVolunteer({ name: 'Late' })
    const req = await prisma.contactRequest.create({
      data: { fromVolunteerId: late.id, toVolunteerId: me.id, message: 'x'.repeat(20) },
    })
    await view(late.id)
    const third = await screen.findByRole('region', { name: 'Contact request' })
    await prisma.contactRequest.update({ where: { id: req.id }, data: { status: 'declined' } })
    await userEvent.click(within(third).getByRole('button', { name: 'Accept' }))
    await screen.findByText('Request not found')
    cleanup()

    // An owner can read a hidden applicant's profile but cannot reach them yet.
    const hidden = await createVolunteer({
      name: 'Hidden Applicant',
      consentMakeProfileVisibleInDirectory: false,
    })
    const p = await createProject({ assigneeId: me.id, status: 'in_progress' })
    await prisma.workItemInterest.create({
      data: { workItemId: p.id, volunteerId: hidden.id, interestType: 'want_to_contribute' },
    })
    await view(hidden.id)
    await screen.findByText('You can reach them once you work on a project together.')
  })

  it('tells a global admin which account a duplicate stands for', async () => {
    const kept = await createVolunteer({ name: 'Kept Account' })
    const old = await createVolunteer({ name: 'Old Account', duplicateOfId: kept.id })
    await renderApp(<VolunteerDetailPage params={Promise.resolve({ id: String(old.id) })} />, {
      as: await createAdmin(),
    })
    await screen.findByRole('heading', { name: 'Old Account' })
    expect(screen.getByText(/Duplicate account of/)).toBeInTheDocument()
    expect(await screen.findByRole('link', { name: 'Kept Account' })).toHaveAttribute(
      'href',
      `/volunteers/${kept.id}`,
    )
  })

  async function showPictureToLead(name: string) {
    const chapter = await createChapter()
    const member = await createMember(chapter, { name })
    await prisma.profilePicture.create({
      data: { volunteerId: member.id, publicId: `picture-${member.id}`, data: new Uint8Array([1]) },
    })
    await renderApp(<VolunteerDetailPage params={Promise.resolve({ id: String(member.id) })} />, {
      as: await createChapterLead(chapter),
    })
    await screen.findByRole('heading', { name })
    return { member, open: await screen.findByRole('button', { name: 'Remove picture' }) }
  }
  const confirmRemoval = async () =>
    userEvent.click(
      within(await screen.findByRole('dialog', { name: 'Remove profile picture?' })).getByRole(
        'button',
        { name: 'Remove picture' },
      ),
    )

  it("lets the volunteer's chapter staff take down their picture", async () => {
    const { member, open } = await showPictureToLead('Pic Member')
    await userEvent.click(open)
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())

    await userEvent.click(open)
    await confirmRemoval()
    expect(await screen.findByText('Picture removed')).toBeInTheDocument()
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Remove picture' })).toBeNull())
    expect(await prisma.profilePicture.count({ where: { volunteerId: member.id } })).toBe(0)
  })

  it('shows the profile as it is when someone else took the picture down first', async () => {
    const { member, open } = await showPictureToLead('Gone Member')
    await prisma.profilePicture.delete({ where: { volunteerId: member.id } })
    await userEvent.click(open)
    await confirmRemoval()
    expect(await screen.findByText('They have no picture')).toBeInTheDocument()
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Remove picture' })).toBeNull())
  })

  it("shows fast track to the volunteer and their chapter's staff, who set it from Manage", async () => {
    const chapter = await createChapter()
    const lead = await createChapterLead(chapter)
    const sam = await createMember(chapter, { name: 'Sam Steady' })
    const mount = (as: { id: number }) =>
      renderApp(<VolunteerDetailPage params={Promise.resolve({ id: String(sam.id) })} />, {
        as: as as never,
      })
    await mount(lead)
    await userEvent.click(await screen.findByRole('button', { name: 'Fast track Sam Steady' }))
    await screen.findByText('On fast track')
    const section = await screen.findByRole('region', { name: 'Fast track' })
    await within(section).findByText(/Sam Steady starts tasks straight away/)
    expect((await prisma.volunteer.findUniqueOrThrow({ where: { id: sam.id } })).fastTrack).toBe(
      true,
    )
    // A refusal says why: the lead stepped down meanwhile.
    await prisma.nationalChapter.update({ where: { id: chapter.id }, data: { leadId: null } })
    await userEvent.click(
      within(screen.getByRole('region', { name: 'Manage' })).getByRole('button', {
        name: 'Take off fast track',
      }),
    )
    await screen.findByText("Only their chapter's lead or deputies can change fast track")

    cleanup()
    queryClient.clear()
    await mount(sam)
    expect(
      within(await screen.findByRole('region', { name: 'Fast track' })).getByText(
        /You start tasks straight away/,
      ),
    ).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /fast track/i })).toBeNull()

    // Off fast track, Sam's own profile says nothing about it.
    await prisma.volunteer.update({ where: { id: sam.id }, data: { fastTrack: false } })
    cleanup()
    queryClient.clear()
    await mount(sam)
    await screen.findByRole('heading', { name: 'Sam Steady' })
    expect(screen.queryByRole('region', { name: 'Fast track' })).toBeNull()

    cleanup()
    queryClient.clear()
    await mount(await createMember(chapter))
    await screen.findByRole('heading', { name: 'Sam Steady' })
    expect(screen.queryByRole('region', { name: 'Fast track' })).toBeNull()
  })

  it("lets a chapter's lead make a member a chapter deputy, and stand them down", async () => {
    const chapter = await createChapter()
    const lead = await createChapterLead(chapter)
    const member = await createMember(chapter, { name: 'Dee Puty' })
    await renderApp(<VolunteerDetailPage params={Promise.resolve({ id: String(member.id) })} />, {
      as: lead,
    })
    await userEvent.click(await screen.findByRole('button', { name: 'Make chapter deputy' }))
    await userEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }),
    )
    expect(screen.queryByRole('dialog')).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'Make chapter deputy' }))
    const appoint = screen.getByRole('dialog', {
      name: `Make Dee Puty a ${chapter.name} chapter deputy?`,
    })
    await userEvent.click(within(appoint).getByRole('button', { name: 'Make chapter deputy' }))
    await screen.findByText('Dee Puty is now a deputy')
    expect(
      await prisma.chapterDeputy.findUnique({ where: { volunteerId: member.id } }),
    ).toMatchObject({ nationalChapterId: chapter.id, appointedById: lead.id })

    await userEvent.click(await screen.findByRole('button', { name: 'Remove as chapter deputy' }))
    const remove = screen.getByRole('dialog', {
      name: `Remove Dee Puty as a ${chapter.name} chapter deputy?`,
    })
    await userEvent.click(within(remove).getByRole('button', { name: 'Remove as chapter deputy' }))
    await screen.findByText('Deputy removed')
    await screen.findByRole('button', { name: 'Make chapter deputy' })
    expect(await prisma.chapterDeputy.findUnique({ where: { volunteerId: member.id } })).toBeNull()

    // A refused save is reported.
    await userEvent.click(screen.getByRole('button', { name: 'Make chapter deputy' }))
    localStorage.setItem('authToken', 'stale')
    await userEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Make chapter deputy' }),
    )
    await screen.findByText('Unauthorized')
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('shows the deputy control as it now is when someone else changed it first', async () => {
    const chapter = await createChapter()
    const lead = await createChapterLead(chapter)
    const member = await createMember(chapter, { name: 'Raced Member' })
    await renderApp(<VolunteerDetailPage params={Promise.resolve({ id: String(member.id) })} />, {
      as: lead,
    })
    await userEvent.click(await screen.findByRole('button', { name: 'Make chapter deputy' }))
    await prisma.chapterDeputy.create({
      data: { nationalChapterId: chapter.id, volunteerId: member.id },
    })
    await userEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Make chapter deputy' }),
    )
    await screen.findByText('Raced Member is already a deputy')
    await screen.findByRole('button', { name: 'Remove as chapter deputy' })
  })

  const openProfile = async (
    member: { id: number; name: string },
    as: Awaited<ReturnType<typeof createVolunteer>>,
  ) => {
    await renderApp(<VolunteerDetailPage params={Promise.resolve({ id: String(member.id) })} />, {
      as,
    })
    await screen.findByRole('heading', { name: member.name })
  }
  const dialogNamed = (name: string) => screen.getByRole('dialog', { name })
  const confirmIn = (dialog: HTMLElement, label: string) =>
    userEvent.click(within(dialog).getByRole('button', { name: label }))

  it('shows no Manage panel to a fellow member or a coordinator', async () => {
    const chapter = await createChapter()
    const member = await createMember(chapter, { name: 'Plain Member' })
    await openProfile(member, await createMember(chapter))
    expect(screen.queryByRole('heading', { name: 'Manage' })).toBeNull()
    cleanup()
    await openProfile(member, await createCoordinator(chapter))
    expect(screen.queryByRole('heading', { name: 'Manage' })).toBeNull()
  })

  it("shows a chapter's deputy the member's admin record, and no role controls", async () => {
    const chapter = await createChapter()
    const member = await createMember(chapter, { name: 'Deputy Viewed' })
    await openProfile(member, await createChapterDeputy(chapter))
    const panel = screen.getByRole('region', { name: 'Manage' })
    expect(within(panel).getByRole('link', { name: 'Admin record' })).toHaveAttribute(
      'href',
      `/admin/volunteers/${member.id}`,
    )
    expect(within(panel).queryByRole('group', { name: 'Role and access' })).toBeNull()
    expect(within(panel).queryByRole('button', { name: 'Remove picture' })).toBeNull()
  })

  it('lets a global admin make a member lead in place of the current one, and remove them', async () => {
    const chapter = await createChapter()
    await createChapterLead(chapter, { name: 'Old Lead' })
    const member = await createMember(chapter, { name: 'New Lead' })
    await openProfile(member, await createAdmin())

    await userEvent.click(screen.getByRole('button', { name: 'Make chapter lead' }))
    const appoint = dialogNamed(`Make New Lead lead of the ${chapter.name} chapter?`)
    expect(appoint).toHaveTextContent('Old Lead stops leading it and stays a member.')
    await confirmIn(appoint, 'Make chapter lead')
    await screen.findByText('New Lead now leads the chapter')
    expect(await prisma.nationalChapter.findUnique({ where: { id: chapter.id } })).toMatchObject({
      leadId: member.id,
    })

    await userEvent.click(await screen.findByRole('button', { name: 'Remove as chapter lead' }))
    await confirmIn(
      dialogNamed(`Remove New Lead as lead of the ${chapter.name} chapter?`),
      'Remove as chapter lead',
    )
    await screen.findByText('The chapter has no lead now')
    await screen.findByRole('button', { name: 'Make chapter lead' })
    await userEvent.click(screen.getByRole('button', { name: 'Make chapter lead' }))
    expect(dialogNamed(`Make New Lead lead of the ${chapter.name} chapter?`)).not.toHaveTextContent(
      'stops leading it',
    )
  })

  it("warns that making a deputy the chapter's lead ends their deputy role", async () => {
    const chapter = await createChapter()
    const deputy = await createChapterDeputy(chapter, { name: 'Rising Deputy' })
    await openProfile(deputy, await createAdmin())
    await userEvent.click(screen.getByRole('button', { name: 'Make chapter lead' }))
    const appoint = dialogNamed(`Make Rising Deputy lead of the ${chapter.name} chapter?`)
    expect(appoint).toHaveTextContent('Rising Deputy stops being a deputy.')
    await confirmIn(appoint, 'Make chapter lead')
    await screen.findByText('Rising Deputy now leads the chapter')
    expect(await prisma.chapterDeputy.findUnique({ where: { volunteerId: deputy.id } })).toBeNull()
  })

  it('lets a global admin make a member a coordinator with a remit, and remove them', async () => {
    const chapter = await createChapter()
    const member = await createMember(chapter, { name: 'Coord Hopeful' })
    await openProfile(member, await createAdmin())

    await userEvent.click(screen.getByRole('button', { name: 'Make coordinator' }))
    const appoint = dialogNamed('Make Coord Hopeful a coordinator?')
    await userEvent.type(within(appoint).getByLabelText(/What they coordinate/), ' Press ')
    await confirmIn(appoint, 'Make coordinator')
    await screen.findByText('Coord Hopeful is a coordinator')
    expect(
      await prisma.coordinator.findUnique({ where: { volunteerId: member.id } }),
    ).toMatchObject({ remit: 'Press' })

    await userEvent.click(await screen.findByRole('button', { name: 'Remove as coordinator' }))
    const remove = dialogNamed('Remove Coord Hopeful as a coordinator?')
    expect(remove).toHaveTextContent('Coord Hopeful, who coordinates Press, can no longer')
    await confirmIn(remove, 'Remove as coordinator')
    await screen.findByText('They are no longer a coordinator')
    expect(await prisma.coordinator.findUnique({ where: { volunteerId: member.id } })).toBeNull()
    // What was typed before is gone when the dialog opens again.
    await userEvent.click(await screen.findByRole('button', { name: 'Make coordinator' }))
    expect(
      within(dialogNamed('Make Coord Hopeful a coordinator?')).getByLabelText(
        /What they coordinate/,
      ),
    ).toHaveValue('')
  })

  it('appoints a coordinator with no remit when none is given', async () => {
    const member = await createMember(await createChapter(), { name: 'No Remit' })
    await openProfile(member, await createAdmin())
    await userEvent.click(screen.getByRole('button', { name: 'Make coordinator' }))
    await confirmIn(dialogNamed('Make No Remit a coordinator?'), 'Make coordinator')
    await screen.findByText('No Remit is a coordinator')
    expect(
      await prisma.coordinator.findUnique({ where: { volunteerId: member.id } }),
    ).toMatchObject({ remit: null })
    await userEvent.click(await screen.findByRole('button', { name: 'Remove as coordinator' }))
    expect(dialogNamed('Remove No Remit as a coordinator?')).toHaveTextContent(
      'No Remit can no longer',
    )
  })

  it('lets a global admin move a member to another chapter or the pool', async () => {
    const from = await createChapter()
    const to = await createChapter()
    const member = await createMember(from, { name: 'Moving Member' })
    await openProfile(member, await createAdmin())

    await userEvent.click(screen.getByRole('button', { name: 'Move to another chapter' }))
    const dialog = dialogNamed('Move Moving Member to another chapter?')
    // Move waits for a chapter to be chosen.
    expect(within(dialog).getByRole('button', { name: 'Move' })).toBeDisabled()
    const select = within(dialog).getByLabelText('Move to')
    await within(select).findByRole('option', { name: to.name })
    expect(within(select).queryByRole('option', { name: from.name })).toBeNull()
    await userEvent.selectOptions(select, 'pool')
    expect(dialog).toHaveTextContent('They join the holding pool.')
    await userEvent.selectOptions(select, String(to.id))
    expect(dialog).toHaveTextContent(`They join ${to.name}.`)
    await confirmIn(dialog, 'Move')
    await screen.findByText('Moved')
    expect(await prisma.volunteer.findUnique({ where: { id: member.id } })).toMatchObject({
      nationalChapterId: to.id,
    })
    // Opened again, it starts from nothing rather than the chapter they are now in.
    await userEvent.click(screen.getByRole('button', { name: 'Move to another chapter' }))
    const again = dialogNamed('Move Moving Member to another chapter?')
    expect(within(again).getByLabelText('Move to')).toHaveValue('')
    expect(within(again).getByRole('button', { name: 'Move' })).toBeDisabled()
  })

  it('offers no move to the pool for someone already in it', async () => {
    const pooled = await createVolunteer({ name: 'Pooled Person' })
    await openProfile(pooled, await createAdmin())
    await userEvent.click(screen.getByRole('button', { name: 'Move to another chapter' }))
    const select = within(dialogNamed('Move Pooled Person to another chapter?')).getByLabelText(
      'Move to',
    )
    expect(within(select).queryByRole('option', { name: 'Holding pool' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Make chapter lead' })).toBeNull()
  })

  it('links a global admin to their own admin record, with no Manage panel', async () => {
    const admin = await createAdmin({ name: 'Self Admin' })
    await openProfile(admin, admin)
    expect(screen.getByRole('link', { name: 'Admin record' })).toHaveAttribute(
      'href',
      `/admin/volunteers/${admin.id}`,
    )
    expect(screen.queryByRole('heading', { name: 'Manage' })).toBeNull()
  })

  it("lets a chapter's staff verify one of a member's skills", async () => {
    const chapter = await createChapter()
    const listed = await createSkill({ name: 'Listed Skill' })
    const other = await createSkill({ name: 'Other Skill' })
    const member = await createMember(chapter, { name: 'Skilled Member' })
    await prisma.volunteerSkill.create({ data: { volunteerId: member.id, skillId: listed.id } })
    const deputy = await createChapterDeputy(chapter)
    await openProfile(member, deputy)

    await userEvent.click(screen.getByRole('button', { name: 'Verify a skill' }))
    const dialog = dialogNamed("Verify one of Skilled Member's skills")
    expect(within(dialog).getByRole('button', { name: 'Verify skill' })).toBeDisabled()
    const select = within(dialog).getByLabelText('Skill')
    expect(within(select).getByRole('group', { name: 'Skills they list' })).toHaveTextContent(
      'Listed Skill',
    )
    await within(select).findByRole('option', { name: 'Other Skill' })
    await userEvent.selectOptions(select, String(other.id))
    await userEvent.selectOptions(within(dialog).getByLabelText('How well'), 'strong')
    await userEvent.selectOptions(within(dialog).getByLabelText('Based on'), 'project_outcome')
    await confirmIn(dialog, 'Verify skill')
    await screen.findByText('Skill endorsed')
    expect(
      await prisma.skillEndorsement.findFirst({ where: { volunteerId: member.id } }),
    ).toMatchObject({
      skillId: other.id,
      endorsedById: deputy.id,
      rating: 'strong',
      source: 'project_outcome',
    })
  })

  it('offers only the other skills when a member lists none', async () => {
    const chapter = await createChapter()
    const member = await createMember(chapter, { name: 'No Listed' })
    const offered = await createSkill({ name: 'Offered Anyway' })
    await openProfile(member, await createChapterLead(chapter))
    await userEvent.click(screen.getByRole('button', { name: 'Verify a skill' }))
    const select = within(dialogNamed("Verify one of No Listed's skills")).getByLabelText('Skill')
    expect(await within(select).findByRole('option', { name: offered.name })).toBeInTheDocument()
    expect(within(select).queryByRole('group', { name: 'Skills they list' })).toBeNull()
  })

  it("lets a chapter's staff invite a member to a project, or add them to one", async () => {
    const chapter = await createChapter()
    const member = await createMember(chapter, { name: 'Invitable' })
    const at = { nationalChapterId: chapter.id, status: 'in_progress' as const }
    const first = await createProject({ ...at, title: 'First Project' })
    const second = await createProject({ ...at, title: 'Second Project' })
    const asked = await createProject({ ...at, title: 'Asked Project' })
    await prisma.workItemInterest.create({
      data: {
        workItemId: asked.id,
        volunteerId: member.id,
        status: 'pending',
        interestType: 'want_to_contribute',
      },
    })
    await openProfile(member, await createChapterLead(chapter))

    await userEvent.click(screen.getByRole('button', { name: 'Invite to a project' }))
    let dialog = dialogNamed('Invite Invitable to a project')
    const pick = async (title: string | RegExp) => {
      const select = await within(dialog).findByLabelText('Project')
      const option = await within(select).findByRole('option', { name: title })
      await userEvent.selectOptions(select, option)
    }
    expect(within(dialog).getByRole('button', { name: 'Send invite' })).toBeDisabled()
    await pick(/Asked Project \(asked to join\)/)
    expect(dialog).toHaveTextContent('They asked to join this one')
    await pick('First Project')
    await userEvent.type(within(dialog).getByLabelText('Note (optional)'), 'Come and help')
    await confirmIn(dialog, 'Send invite')
    await screen.findByText('Invite sent')
    expect(
      await prisma.workItemInterest.findFirst({
        where: { workItemId: first.id, volunteerId: member.id },
      }),
    ).toMatchObject({ status: 'invited', message: 'Come and help' })
    expect(emails.lastTo(member.email as string)?.subject).toContain('First Project')

    // Invited already: a second invite waits, but adding them straight away does not.
    await userEvent.click(screen.getByRole('button', { name: 'Invite to a project' }))
    dialog = dialogNamed('Invite Invitable to a project')
    await pick(/First Project \(invited already\)/)
    expect(within(dialog).getByRole('button', { name: 'Send invite' })).toBeDisabled()
    await pick('Second Project')
    await userEvent.click(within(dialog).getByLabelText('Add them now, without asking'))
    expect(within(dialog).queryByLabelText('Note (optional)')).toBeNull()
    await confirmIn(dialog, 'Add to project')
    await screen.findByText(/assigned|added/i)
    expect(
      await prisma.workItemInterest.findFirst({
        where: { workItemId: second.id, volunteerId: member.id },
      }),
    ).toMatchObject({ status: 'accepted', origin: 'added' })
    await userEvent.click(screen.getByRole('button', { name: 'Invite to a project' }))
    dialog = dialogNamed('Invite Invitable to a project')
    await userEvent.click(within(dialog).getByLabelText('Add them now, without asking'))
    await userEvent.click(within(dialog).getByLabelText('Invite them: they accept or decline'))
    expect(within(dialog).getByLabelText('Note (optional)')).toBeInTheDocument()
  })

  it('says when there is no project to invite a member to, and offers none to an applicant', async () => {
    const chapter = await createChapter()
    const member = await createMember(chapter, { name: 'Nothing Open' })
    const lead = await createChapterLead(chapter)
    await openProfile(member, lead)
    await userEvent.click(screen.getByRole('button', { name: 'Invite to a project' }))
    expect(
      await within(dialogNamed('Invite Nothing Open to a project')).findByText(
        `There is no live project in the ${chapter.name} chapter that they are not already on.`,
      ),
    ).toBeInTheDocument()
    cleanup()
    const applicant = await createMember(chapter, {
      name: 'Still Applying',
      approvalStatus: 'pending',
    })
    await openProfile(applicant, lead)
    expect(screen.queryByRole('group', { name: 'Work' })).toBeNull()

    // Nor any work on a duplicate account, which goes on the account in use.
    cleanup()
    const duplicate = await createMember(chapter, {
      name: 'Second Account',
      duplicateOfId: member.id,
    })
    await openProfile(duplicate, lead)
    expect(screen.queryByRole('button', { name: 'Verify a skill' })).toBeNull()
    expect(screen.queryByRole('button', { name: /fast track/i })).toBeNull()
  })

  it('says while projects load, and when they cannot be', async () => {
    const chapter = await createChapter()
    const member = await createMember(chapter, { name: 'Soon Gone' })
    await openProfile(member, await createChapterLead(chapter))
    await prisma.volunteer.update({ where: { id: member.id }, data: { deletedAt: new Date() } })
    await userEvent.click(screen.getByRole('button', { name: 'Invite to a project' }))
    const dialog = dialogNamed('Invite Soon Gone to a project')
    expect(dialog).toHaveTextContent('Loading projects…')
    expect(
      await within(dialog).findByText(
        'Their projects could not be loaded. Close this and try again.',
      ),
    ).toBeInTheDocument()
  })

  it('shows a skill verified by several people once', async () => {
    const chapter = await createChapter()
    const skill = await createSkill({ name: 'Twice Verified' })
    const member = await createMember(chapter, { name: 'Well Verified' })
    for (const [rating, by] of [
      ['strong', await createChapterLead(chapter)],
      ['verified', await createChapterDeputy(chapter)],
      ['developing', await createChapterDeputy(chapter)],
    ] as const) {
      await prisma.skillEndorsement.create({
        data: { volunteerId: member.id, skillId: skill.id, endorsedById: by.id, rating },
      })
    }
    await openProfile(member, await createMember(chapter))
    expect(screen.getAllByText('Twice Verified', { exact: true })).toHaveLength(1)
  })

  it('shows a minimal profile, and a not-found state', async () => {
    const me = await createVolunteer()
    const bare = await createVolunteer({
      name: 'Bare',
      location: null,
      country: 'Atlantis',
      availabilityHoursPerWeek: null,
    })
    await renderApp(<VolunteerDetailPage params={Promise.resolve({ id: String(bare.id) })} />, {
      as: me,
    })
    await screen.findByRole('heading', { name: 'Bare' })
    expect(document.getElementById('volunteerPlace')).toHaveTextContent(
      /^No national chapter yet \(Atlantis\)$/,
    )
    expect(screen.queryByRole('button', { name: 'Message' })).toBeNull()
    await userEvent.click(await screen.findByRole('button', { name: 'Request contact' }))
    const ask = await screen.findByRole('dialog', { name: 'Connect with Bare' })
    await userEvent.type(
      within(ask).getByLabelText('Why would you like to connect?'),
      'Hello there, I would like to talk about leafleting.',
    )
    // They leave the directory before the request goes.
    await prisma.volunteer.update({
      where: { id: bare.id },
      data: { consentMakeProfileVisibleInDirectory: false },
    })
    await userEvent.click(within(ask).getByRole('button', { name: 'Send request' }))
    await screen.findByText('Volunteer not found')
    expect(screen.queryByText('Verified skills')).toBeNull()
    cleanup()
    await renderApp(<VolunteerDetailPage params={Promise.resolve({ id: '999999' })} />, { as: me })
    await screen.findByRole('link', { name: 'Back to volunteers' })
  })
})
