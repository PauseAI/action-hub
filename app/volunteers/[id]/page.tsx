'use client'

import { use } from 'react'
import { useRequireAuth } from '@/lib/hooks/auth'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import Link from 'next/link'
import Button from '@/components/Button'
import ProjectHistory from '@/components/ProjectHistory'
import ContactButton from '@/components/ContactButton'
import ActiveDot from '@/components/ActiveDot'
import Tooltip from '@/components/Tooltip'
import { formatDate } from '@/lib/format-date'
import Linkify from '@/components/Linkify'
import { useToast } from '@/lib/toast'
import { countryFlag } from '@/lib/flags'
import { useCountries } from '@/lib/hooks/countries'
import { orpc } from '@/lib/orpc'
import { SECTION_CARD } from '@/lib/ui-classes'
import { H1, H2, H3, H4 } from '@/components/Heading'
import { P } from '@/components/Text'
import { Badge } from '@/components/Badge'
import TextLink from '@/components/TextLink'
import PersonName, { RoleBadge } from '@/components/PersonName'
import { usePerson } from '@/lib/hooks/usePerson'
import Avatar from '@/components/Avatar'
import MemberManage from '@/components/MemberManage'

type Endorsement = {
  skillId: number
  skillName: string
  rating: string | null
  source: string | null
  /** Null for a viewer outside the person's chapter staff, or once the endorser is deleted. */
  endorsedByName: string | null
  createdAt: Date | null
}

const ENDORSED_FOR: Record<string, string> = {
  project_outcome: ' for delivering a project',
  quick_task: ' for a reviewed quick task',
  direct_observation: ' from direct observation',
}

/** One line per endorsement: who verified the skill, for what, and when. */
function verifiedBy(e: Endorsement): string {
  const how =
    e.rating === 'strong'
      ? 'Verified as strong'
      : e.rating === 'developing'
        ? 'Rated as developing'
        : 'Verified'
  const by = e.endorsedByName ? ` by ${e.endorsedByName}` : ''
  const when = e.createdAt ? `, ${formatDate(e.createdAt)}` : ''
  return `${how}${by}${ENDORSED_FOR[e.source ?? ''] ?? ''}${when}`
}

type Chip = { id: number; name: string; lines: string[]; verified: boolean }

/** The skills someone lists, then any endorsed skill they do not, each with its endorsements. */
function skillChips(listed: { id: number; name: string }[], endorsements: Endorsement[]) {
  const chips = new Map<number, Chip>(
    listed.map((s) => [s.id, { id: s.id, name: s.name, lines: [], verified: false }]),
  )
  for (const e of endorsements) {
    const chip = chips.get(e.skillId) ?? {
      id: e.skillId,
      name: e.skillName,
      lines: [],
      verified: false,
    }
    chip.lines.push(verifiedBy(e))
    chip.verified ||= e.rating !== 'developing'
    chips.set(e.skillId, chip)
  }
  return [...chips.values()]
}

/**
 * A skill, with a tooltip saying who endorsed it when anyone has; marked ✓ only once someone has
 * verified it, so one rated only as developing does not read as verified.
 */
function SkillChip({ name, lines, verified }: Chip) {
  const chip =
    'inline-flex items-center px-3 py-1 bg-chip text-chip-text rounded-full text-sm font-medium'
  if (lines.length === 0) return <span className={chip}>{name}</span>
  return (
    <Tooltip
      content={lines.map((l, i) => (
        <span key={i} className="block">
          {l}
        </span>
      ))}
    >
      <span tabIndex={0} className={`${chip} gap-1${verified ? ' ring-1 ring-success' : ''}`}>
        <span>{name}</span>
        {verified && (
          <span aria-hidden="true" className="text-success">
            ✓
          </span>
        )}
        <span className="sr-only">
          ({verified ? 'verified' : 'rated'}: {lines.join('; ')})
        </span>
      </span>
    </Tooltip>
  )
}

/** Fast track (lib/fast-track.ts), shown to the volunteer and their chapter's staff. */
function FastTrackNote({ name, isMe }: { name: string; isMe: boolean }) {
  return (
    <section aria-label="Fast track" className="mt-2 text-sm">
      <P className="m-0">
        <Badge variant="success">Fast track</Badge>{' '}
        {isMe
          ? 'You start tasks straight away, without waiting for approval. Owners are told.'
          : `${name} starts tasks straight away, without waiting for approval.`}
      </P>
    </section>
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

  const skills = skillChips(volunteer.skills ?? [], volunteer.endorsements ?? [])
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
                {volunteer.fastTrack?.on && <FastTrackNote name={volunteer.name} isMe={isMe} />}
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

            {isMe && user.access.globalAdmin && (
              <P className="text-sm mt-0 mb-2">
                <Link
                  className="text-primary-text underline"
                  href={`/admin/volunteers/${volunteer.id}`}
                >
                  Admin record
                </Link>
              </P>
            )}
            {volunteer.duplicateOf && (
              <P className="text-sm mt-0 mb-2">
                Duplicate account of{' '}
                <PersonName id={volunteer.duplicateOf.id} name={volunteer.duplicateOf.name} />
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
                skills.map(({ id, ...s }) => <SkillChip key={id} id={id} {...s} />)
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

          {volunteer.manage && (
            <MemberManage
              member={{
                id: volunteer.id,
                name: volunteer.name,
                chapterName: volunteer.chapter?.name ?? null,
                skills: volunteer.skills ?? [],
              }}
              manage={volunteer.manage}
              hasPicture={Boolean(person?.picture)}
            />
          )}

          {volunteer.completedTasks.length > 0 && (
            <div className={`${SECTION_CARD} mb-4 overflow-hidden wrap-break-word`}>
              <H2>Completed requests for help</H2>
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
