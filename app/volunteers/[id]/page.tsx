'use client'

import { use, useState } from 'react'
import { useRequireAuth } from '@/lib/hooks/auth'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import Link from 'next/link'
import Button from '@/components/Button'
import ProjectHistory from '@/components/ProjectHistory'
import ContactButton from '@/components/ContactButton'
import ActiveDot from '@/components/ActiveDot'
import Linkify from '@/components/Linkify'
import { useToast } from '@/lib/toast'
import { countryFlag } from '@/lib/flags'
import { useCountries } from '@/lib/hooks/countries'
import { orpc } from '@/lib/orpc'
import { SECTION_CARD } from '@/lib/ui-classes'
import { H1, H2, H3, H4 } from '@/components/Heading'
import { P } from '@/components/Text'
import TextLink from '@/components/TextLink'
import PersonName, { RoleBadge } from '@/components/PersonName'
import { usePerson } from '@/lib/hooks/usePerson'
import Avatar from '@/components/Avatar'
import ConfirmDialog from '@/components/ui/ConfirmDialog'

/** Staff take down a picture that should not be shown; the volunteer is left with initials. */
function RemovePicture({ volunteerId, name }: { volunteerId: number; name: string }) {
  const [open, setOpen] = useState(false)
  const showToast = useToast()
  const queryClient = useQueryClient()
  const remove = useMutation({
    ...orpc.profilePictures.removeFor.mutationOptions(),
    onSuccess: () => {
      setOpen(false)
      showToast('Picture removed', 'success')
      void queryClient.invalidateQueries({ queryKey: ['person'] })
    },
    onError: (err: unknown) => {
      showToast(err instanceof Error ? err.message : 'Failed to remove the picture', 'error')
      // Someone else may have taken it down first; show the profile as it now is.
      setOpen(false)
      void queryClient.invalidateQueries({ queryKey: ['person'] })
    },
  })
  return (
    <>
      <Button variant="danger" size="sm" className="mt-2" onClick={() => setOpen(true)}>
        Remove picture
      </Button>
      <ConfirmDialog
        id="remove-picture-dialog"
        isOpen={open}
        title="Remove profile picture?"
        body={`${name} will be shown with their initials, and told their picture was taken down. They can upload another.`}
        confirmLabel="Remove picture"
        danger
        busy={remove.isPending}
        busyLabel="Removing…"
        onConfirm={() => remove.mutate({ volunteerId })}
        onClose={() => setOpen(false)}
      />
    </>
  )
}

/** A chapter lead makes one of their members a deputy, or stands a deputy down. */
function DeputyControl({
  volunteerId,
  name,
  chapterName,
  deputy,
}: {
  volunteerId: number
  name: string
  chapterName: string
  deputy: { chapterId: number; isDeputy: boolean }
}) {
  const [open, setOpen] = useState(false)
  const showToast = useToast()
  const queryClient = useQueryClient()
  // Refetched either way: a refusal usually means someone else changed it first.
  const refresh = () => {
    setOpen(false)
    void queryClient.invalidateQueries({ queryKey: orpc.volunteers.getById.key() })
    void queryClient.invalidateQueries({ queryKey: orpc.admin.chapters.key() })
    void queryClient.invalidateQueries({ queryKey: ['person'] })
  }
  const options = {
    onSuccess: ({ message }: { message: string }) => {
      refresh()
      showToast(message, 'success')
    },
    onError: (err: unknown) => {
      refresh()
      showToast(err instanceof Error ? err.message : 'Failed to save', 'error')
    },
  }
  const appoint = useMutation({
    ...orpc.admin.chapters.appointDeputy.mutationOptions(),
    ...options,
  })
  const remove = useMutation({ ...orpc.admin.chapters.removeDeputy.mutationOptions(), ...options })
  const input = { chapterId: deputy.chapterId, volunteerId }
  const label = deputy.isDeputy ? 'Remove as chapter deputy' : 'Make chapter deputy'
  return (
    <>
      <Button variant="secondary" size="sm" className="mt-2" onClick={() => setOpen(true)}>
        {label}
      </Button>
      <ConfirmDialog
        id="deputy-dialog"
        isOpen={open}
        title={
          deputy.isDeputy
            ? `Remove ${name} as a ${chapterName} chapter deputy?`
            : `Make ${name} a ${chapterName} chapter deputy?`
        }
        body={
          deputy.isDeputy
            ? `${name} stays a member of the ${chapterName} chapter, without a deputy's admin access.`
            : `Deputies help run the ${chapterName} chapter, with admin access to its members and projects. You can remove them at any time.`
        }
        confirmLabel={label}
        busy={appoint.isPending || remove.isPending}
        busyLabel="Saving…"
        onConfirm={() => (deputy.isDeputy ? remove : appoint).mutate(input)}
        onClose={() => setOpen(false)}
      />
    </>
  )
}

export default function VolunteerDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const { user, loading } = useRequireAuth()
  const { label: countryLabel, loaded: countriesLoaded } = useCountries()
  const showToast = useToast()
  const queryClient = useQueryClient()
  const respond = useMutation({
    ...orpc.contacts.respond.mutationOptions(),
    onSuccess: (_data, variables) => {
      showToast(
        variables.accept
          ? 'Connected. You can now message each other.'
          : 'Request declined. They are not told.',
        'success',
      )
      void queryClient.invalidateQueries({ queryKey: orpc.volunteers.getById.key() })
      void queryClient.invalidateQueries({ queryKey: orpc.notifications.key() })
    },
    onError: (err: unknown) =>
      showToast(err instanceof Error ? err.message : 'Failed to answer the request', 'error'),
  })

  const {
    data: volunteer,
    isLoading: loadingProfile,
    isError,
  } = useQuery({
    ...orpc.volunteers.getById.queryOptions({ input: { id: parseInt(id, 10) } }),
    enabled: !!user,
  })
  const person = usePerson(volunteer?.id)

  if (loading || !user) return null

  if (loadingProfile || !countriesLoaded) {
    return (
      <>
        <main className="container py-5 pb-15">
          <div className="text-center py-10 text-text-light">Loading profile…</div>
        </main>
      </>
    )
  }

  if (isError || !volunteer) {
    return (
      <>
        <main className="container py-5 pb-15">
          <P className="text-error">Volunteer not found.</P>
          <Button href="/volunteers" variant="outline" className="mt-4">
            Back to volunteers
          </Button>
        </main>
      </>
    )
  }

  const skills = volunteer.skills ?? []
  const endorsements = volunteer.endorsements ?? []
  const endorsedSkillIds = new Set(endorsements.map((e) => e.skillId))
  const isMe = volunteer.id === user.id
  const incoming = volunteer.incomingContactRequest

  return (
    <>
      <main className="container py-5 pb-15">
        <div className="mb-5">
          <Link href="/volunteers" className="text-text-light">
            &larr; Back to volunteers
          </Link>
        </div>

        <div id="profileContent">
          {incoming && (
            <section
              aria-label="Contact request"
              className={`${SECTION_CARD} mb-4 border-l-4 border-primary`}
            >
              <H2 className="text-lg m-0 mb-2">{volunteer.name} would like to connect</H2>
              <P className="m-0 mb-3 whitespace-pre-wrap">
                <Linkify text={incoming.message} />
              </P>
              <P className="text-sm text-text-light m-0 mb-3">
                Accepting lets you both see each other&apos;s contact details and message each
                other. Declining is quiet: they are not told.
              </P>
              <div className="flex gap-2">
                <Button
                  disabled={respond.isPending}
                  onClick={() => respond.mutate({ id: incoming.id, accept: true })}
                >
                  Accept
                </Button>
                <Button
                  variant="secondary"
                  disabled={respond.isPending}
                  onClick={() => respond.mutate({ id: incoming.id, accept: false })}
                >
                  Decline
                </Button>
              </div>
            </section>
          )}
          <div className={`${SECTION_CARD} mb-4 overflow-hidden wrap-break-word`}>
            <div className="flex flex-wrap items-center gap-4 mb-3">
              <Avatar id={volunteer.id} name={volunteer.name} size="lg" />
              <div className="min-w-0">
                <div className="flex items-center">
                  <H1 id="volunteerName" className="m-0">
                    {volunteer.name}
                  </H1>
                  <RoleBadge person={person} className="ml-2" />
                  {volunteer.activeRecently && <ActiveDot />}
                </div>
                {volunteer.canRemovePicture && person?.picture && (
                  <RemovePicture volunteerId={volunteer.id} name={volunteer.name} />
                )}
                {volunteer.deputy && volunteer.chapter && (
                  <DeputyControl
                    volunteerId={volunteer.id}
                    name={volunteer.name}
                    chapterName={volunteer.chapter.name}
                    deputy={volunteer.deputy}
                  />
                )}
              </div>
              {isMe && (
                <Button
                  href="/settings?tab=profile"
                  variant="secondary"
                  size="sm"
                  className="ml-auto"
                >
                  Edit profile
                </Button>
              )}
            </div>

            {user.access.globalAdmin && (
              <P className="text-sm mt-0 mb-2">
                {volunteer.duplicateOf && (
                  <>
                    Duplicate account of{' '}
                    <PersonName id={volunteer.duplicateOf.id} name={volunteer.duplicateOf.name} />
                    {' · '}
                  </>
                )}
                <Link
                  className="text-primary-text underline"
                  href={`/admin/volunteers/${volunteer.id}`}
                >
                  Admin page
                </Link>
              </P>
            )}

            <P id="volunteerPlace" className="mb-4 text-sm flex flex-wrap gap-x-4 gap-y-1">
              <span>
                {volunteer.chapter ? (
                  <>
                    {countryFlag(volunteer.chapter.country)} {volunteer.chapter.name} chapter
                  </>
                ) : (
                  <>
                    No national chapter yet
                    {volunteer.country && ` (${countryLabel(volunteer.country)})`}
                  </>
                )}
              </span>
              {volunteer.localGroup && <span>👥 {volunteer.localGroup}</span>}
              {volunteer.location && volunteer.location !== volunteer.localGroup && (
                <span className="text-text-light">📍 {volunteer.location}</span>
              )}
            </P>

            <div id="volunteerBio" className="whitespace-pre-wrap mb-5">
              {volunteer.bio || <em className="text-text-light">No bio provided</em>}
            </div>

            <H3>Skills</H3>
            <div id="volunteerSkills" className="flex flex-wrap gap-1.5 mb-5">
              {skills.length > 0 ? (
                skills.map((s) => (
                  <span
                    key={s.id}
                    className={`inline-flex items-center px-3 py-1 bg-chip text-chip-text rounded-full text-sm font-medium${endorsedSkillIds.has(s.id) ? ' matched' : ''}`}
                  >
                    {s.name}
                    {endorsedSkillIds.has(s.id) ? ' ✓' : ''}
                  </span>
                ))
              ) : (
                <em className="text-text-light">No skills listed</em>
              )}
            </div>

            {volunteer.otherSkills && (
              <div className="mb-5">
                <H4 className="text-text-light">Other skills</H4>
                <P>{volunteer.otherSkills}</P>
              </div>
            )}

            <div className="grid grid-cols-2 gap-4 mt-5 max-[600px]:grid-cols-1">
              {volunteer.availabilityHoursPerWeek && (
                <div>
                  <H4 className="text-text-light">Availability</H4>
                  <P id="availabilityText">{volunteer.availabilityHoursPerWeek} hours/week</P>
                </div>
              )}

              {!isMe && (
                <div id="contactInfo">
                  <H4 className="text-text-light">Contact</H4>
                  <div>
                    {volunteer.email && (
                      <div>
                        Email:{' '}
                        <TextLink href={`mailto:${volunteer.email}`}>{volunteer.email}</TextLink>
                      </div>
                    )}
                    {volunteer.discordHandle && <div>Discord: {volunteer.discordHandle}</div>}
                    {volunteer.signalNumber && <div>Signal: {volunteer.signalNumber}</div>}
                    {volunteer.whatsappNumber && <div>WhatsApp: {volunteer.whatsappNumber}</div>}
                    {volunteer.contactNotes && (
                      <div>
                        <em>{volunteer.contactNotes}</em>
                      </div>
                    )}
                    <div className="mt-2">
                      <ContactButton
                        volunteerId={volunteer.id}
                        name={volunteer.name}
                        canMessage={volunteer.canMessage}
                        canRequestContact={volunteer.canRequestContact}
                        contactRequested={volunteer.contactRequested}
                      />
                      {!volunteer.canMessage &&
                        !volunteer.canRequestContact &&
                        !volunteer.contactRequested && (
                          <P className="text-sm text-text-light m-0">
                            You can reach them once you work on a project together.
                          </P>
                        )}
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>

          {endorsements.length > 0 && (
            <div
              id="endorsementsSection"
              className={`${SECTION_CARD} mb-4 overflow-hidden wrap-break-word`}
            >
              <H2>Verified skills</H2>
              <P className="text-text-light mb-3">
                Skills verified through completed work on the platform.
              </P>
              <div id="endorsementsList" className="flex flex-wrap gap-1.5">
                {endorsements.map((e) => (
                  <span
                    key={e.skillId}
                    className={`inline-flex items-center px-3 py-1 bg-chip text-chip-text rounded-full text-sm font-medium border-l-[3px] ${e.rating === 'strong' ? 'border-l-success' : 'border-l-secondary'}`}
                  >
                    {e.skillName}{' '}
                    <small className={e.rating === 'strong' ? 'text-success' : 'text-text-light'}>
                      {e.rating}
                    </small>
                  </span>
                ))}
              </div>
            </div>
          )}

          {volunteer.completedTasks.length > 0 && (
            <div className={`${SECTION_CARD} mb-4 overflow-hidden wrap-break-word`}>
              <H2>Completed quick tasks</H2>
              {volunteer.completedTasks.map((t, i) => (
                <div key={i} className="py-3 border-b border-brand-border">
                  <div className="flex justify-between items-center">
                    <strong>{t.title}</strong>
                    <span
                      className={`text-sm font-medium ${t.reviewRating === 'excellent' ? 'text-success' : 'text-text-light'}`}
                    >
                      {t.reviewRating}
                    </span>
                  </div>
                  {t.skillName && (
                    <span className="inline-flex items-center px-3 py-1 bg-chip text-chip-text rounded-full text-sm font-medium mt-1">
                      {t.skillName}
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}

          <ProjectHistory
            entries={volunteer.projects}
            viewerIsAdmin={Boolean(user.isAdmin || user.access.role)}
          />
        </div>
      </main>
    </>
  )
}
