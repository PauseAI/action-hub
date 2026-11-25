'use client'

import { useState } from 'react'
import type { InferRouterOutputs } from '@orpc/server'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { AppRouter } from '@/server/router'
import { orpc } from '@/lib/orpc'
import { useToast } from '@/lib/toast'
import { SECTION_CARD } from '@/lib/ui-classes'
import Button from '@/components/Button'
import FormLabel from '@/components/FormLabel'
import { H2, H3 } from '@/components/Heading'
import ConfirmDialog from '@/components/ui/ConfirmDialog'
import Input from '@/components/ui/Input'
import Select from '@/components/ui/Select'
import Textarea from '@/components/ui/Textarea'

export type Manage = NonNullable<InferRouterOutputs<AppRouter>['volunteers']['getById']['manage']>

type Member = {
  id: number
  name: string
  chapterName: string | null
  /** The skills they list, offered first when verifying one. */
  skills: { id: number; name: string }[]
}

/**
 * Saves through `mutation`, then refetches the profile and the people it shows whether or not it
 * worked: a refusal usually means someone else changed it first.
 */
function useManaged(close: () => void, fallback = 'Failed to save') {
  const showToast = useToast()
  const queryClient = useQueryClient()
  const refresh = () => {
    close()
    void queryClient.invalidateQueries({ queryKey: orpc.volunteers.getById.key() })
    void queryClient.invalidateQueries({ queryKey: orpc.admin.key() })
    void queryClient.invalidateQueries({ queryKey: ['person'] })
  }
  return {
    onSuccess: ({ message }: { message: string }) => {
      refresh()
      showToast(message, 'success')
    },
    onError: (err: unknown) => {
      refresh()
      showToast(err instanceof Error ? err.message : fallback, 'error')
    },
  }
}

/** A dialog's open state; `reset` clears what it holds each time it opens. */
function useDialog(reset?: () => void) {
  const [open, setOpen] = useState(false)
  const show = () => {
    reset?.()
    setOpen(true)
  }
  return { open, show, close: () => setOpen(false) }
}

/** Staff take down a picture that should not be shown; the volunteer is left with initials. */
function RemovePicture({ member }: { member: Member }) {
  const dialog = useDialog()
  const remove = useMutation({
    ...orpc.profilePictures.removeFor.mutationOptions(),
    ...useManaged(dialog.close, 'Failed to remove the picture'),
  })
  return (
    <>
      <Button variant="danger" size="sm" onClick={dialog.show}>
        Remove picture
      </Button>
      <ConfirmDialog
        id="remove-picture-dialog"
        isOpen={dialog.open}
        title="Remove profile picture?"
        body={`${member.name} will be shown with their initials, and told their picture was taken down. They can upload another.`}
        confirmLabel="Remove picture"
        danger
        busy={remove.isPending}
        busyLabel="Removing…"
        onConfirm={() => remove.mutate({ volunteerId: member.id })}
        onClose={dialog.close}
      />
    </>
  )
}

function DeputyControl({
  member,
  control,
}: {
  member: Member
  control: NonNullable<Manage['chapterDeputy']>
}) {
  const dialog = useDialog()
  const options = useManaged(dialog.close)
  const appoint = useMutation({
    ...orpc.admin.chapters.appointDeputy.mutationOptions(),
    ...options,
  })
  const remove = useMutation({ ...orpc.admin.chapters.removeDeputy.mutationOptions(), ...options })
  const { name, chapterName } = member
  const label = control.isDeputy ? 'Remove as chapter deputy' : 'Make chapter deputy'
  return (
    <>
      <Button variant="secondary" size="sm" onClick={dialog.show}>
        {label}
      </Button>
      <ConfirmDialog
        id="deputy-dialog"
        isOpen={dialog.open}
        title={
          control.isDeputy
            ? `Remove ${name} as a ${chapterName} chapter deputy?`
            : `Make ${name} a ${chapterName} chapter deputy?`
        }
        body={
          control.isDeputy
            ? `${name} stays a member of the ${chapterName} chapter, without a deputy's admin access.`
            : `Deputies help run the ${chapterName} chapter, with admin access to its members and projects. You can remove them at any time.`
        }
        confirmLabel={label}
        busy={appoint.isPending || remove.isPending}
        busyLabel="Saving…"
        onConfirm={() =>
          (control.isDeputy ? remove : appoint).mutate({
            chapterId: control.chapterId,
            volunteerId: member.id,
          })
        }
        onClose={dialog.close}
      />
    </>
  )
}

function LeadControl({
  member,
  control,
  isDeputy,
}: {
  member: Member
  control: NonNullable<Manage['chapterLead']>
  isDeputy: boolean
}) {
  const dialog = useDialog()
  const options = useManaged(dialog.close)
  const appoint = useMutation({ ...orpc.admin.chapters.appointLead.mutationOptions(), ...options })
  const remove = useMutation({ ...orpc.admin.chapters.removeLead.mutationOptions(), ...options })
  const { name, chapterName } = member
  const label = control.isLead ? 'Remove as chapter lead' : 'Make chapter lead'
  const replaced = control.currentLead
    ? ` ${control.currentLead.name} stops leading it and stays a member.`
    : ''
  const promoted = isDeputy ? ` ${name} stops being a deputy.` : ''
  return (
    <>
      <Button variant="secondary" size="sm" onClick={dialog.show}>
        {label}
      </Button>
      <ConfirmDialog
        id="lead-dialog"
        isOpen={dialog.open}
        title={
          control.isLead
            ? `Remove ${name} as lead of the ${chapterName} chapter?`
            : `Make ${name} lead of the ${chapterName} chapter?`
        }
        body={
          control.isLead
            ? `${name} stays a member, and the chapter has no lead until you appoint one.`
            : `The lead runs the ${chapterName} chapter and appoints its deputies.${replaced}${promoted}`
        }
        confirmLabel={label}
        busy={appoint.isPending || remove.isPending}
        busyLabel="Saving…"
        onConfirm={() =>
          control.isLead
            ? remove.mutate({ chapterId: control.chapterId })
            : appoint.mutate({ chapterId: control.chapterId, volunteerId: member.id })
        }
        onClose={dialog.close}
      />
    </>
  )
}

function CoordinatorControl({
  member,
  control,
}: {
  member: Member
  control: NonNullable<Manage['coordinator']>
}) {
  const [remit, setRemit] = useState('')
  const dialog = useDialog(() => setRemit(''))
  const options = useManaged(dialog.close)
  const appoint = useMutation({ ...orpc.admin.coordinators.appoint.mutationOptions(), ...options })
  const remove = useMutation({ ...orpc.admin.coordinators.remove.mutationOptions(), ...options })
  const { name } = member
  const label = control.isCoordinator ? 'Remove as coordinator' : 'Make coordinator'
  return (
    <>
      <Button variant="secondary" size="sm" onClick={dialog.show}>
        {label}
      </Button>
      <ConfirmDialog
        id="coordinator-dialog"
        isOpen={dialog.open}
        title={
          control.isCoordinator ? `Remove ${name} as a coordinator?` : `Make ${name} a coordinator?`
        }
        body={
          control.isCoordinator ? (
            `${name}${control.remit ? `, who coordinates ${control.remit},` : ''} can no longer put out calls or see every chapter's volunteers, and their open calls close.`
          ) : (
            <>
              <p className="mt-0">
                Coordinators put out calls to volunteers in every chapter, and see and message every
                approved volunteer.
              </p>
              <FormLabel htmlFor="manage-remit">What they coordinate (optional)</FormLabel>
              <Input
                id="manage-remit"
                value={remit}
                maxLength={100}
                onChange={(e) => setRemit(e.target.value)}
                placeholder="Media"
              />
            </>
          )
        }
        confirmLabel={label}
        busy={appoint.isPending || remove.isPending}
        busyLabel="Saving…"
        onConfirm={() =>
          control.isCoordinator
            ? remove.mutate({ volunteerId: member.id })
            : appoint.mutate({ volunteerId: member.id, remit: remit.trim() || null })
        }
        onClose={dialog.close}
      />
    </>
  )
}

/** Staff record that they have seen the member deliver a skill; it shows on the profile. */
function VerifySkill({ member }: { member: Member }) {
  const [skillId, setSkillId] = useState('')
  const [rating, setRating] = useState<'verified' | 'strong'>('verified')
  const [source, setSource] = useState<'direct_observation' | 'project_outcome'>(
    'direct_observation',
  )
  const dialog = useDialog(() => {
    setSkillId('')
    setRating('verified')
    setSource('direct_observation')
  })
  const { data: categories = [] } = useQuery({
    ...orpc.skills.list.queryOptions({ input: {} }),
    enabled: dialog.open,
  })
  const endorse = useMutation({
    ...orpc.admin.volunteers.addEndorsement.mutationOptions(),
    ...useManaged(dialog.close),
  })
  const listed = new Set(member.skills.map((s) => s.id))
  return (
    <>
      <Button variant="secondary" size="sm" onClick={dialog.show}>
        Verify a skill
      </Button>
      <ConfirmDialog
        id="verify-skill-dialog"
        isOpen={dialog.open}
        title={`Verify one of ${member.name}'s skills`}
        body={
          <div className="grid gap-3">
            <p className="m-0">
              Say you have seen them deliver it. It shows as verified on their profile, with your
              name to their chapter&apos;s staff.
            </p>
            <div>
              <FormLabel htmlFor="verify-skill">Skill</FormLabel>
              <Select
                id="verify-skill"
                value={skillId}
                onChange={(e) => setSkillId(e.target.value)}
              >
                <option value="">Choose a skill…</option>
                {member.skills.length > 0 && (
                  <optgroup label="Skills they list">
                    {member.skills.map((s) => (
                      <option key={s.id} value={String(s.id)}>
                        {s.name}
                      </option>
                    ))}
                  </optgroup>
                )}
                {categories.map((c) => (
                  <optgroup key={c.id} label={c.name}>
                    {c.skills
                      .filter((s) => !listed.has(s.id))
                      .map((s) => (
                        <option key={s.id} value={String(s.id)}>
                          {s.name}
                        </option>
                      ))}
                  </optgroup>
                ))}
              </Select>
            </div>
            <div>
              <FormLabel htmlFor="verify-rating">How well</FormLabel>
              <Select
                id="verify-rating"
                value={rating}
                onChange={(e) => setRating(e.target.value as typeof rating)}
              >
                <option value="verified">Verified: can deliver</option>
                <option value="strong">Strong: highly skilled</option>
              </Select>
            </div>
            <div>
              <FormLabel htmlFor="verify-source">Based on</FormLabel>
              <Select
                id="verify-source"
                value={source}
                onChange={(e) => setSource(e.target.value as typeof source)}
              >
                <option value="direct_observation">Seeing their work</option>
                <option value="project_outcome">A project they delivered</option>
              </Select>
            </div>
          </div>
        }
        confirmLabel="Verify skill"
        confirmDisabled={!skillId}
        busy={endorse.isPending}
        busyLabel="Saving…"
        onConfirm={() =>
          endorse.mutate({ volunteerId: member.id, skillId: Number(skillId), rating, source })
        }
        onClose={dialog.close}
      />
    </>
  )
}

/**
 * Staff invite a member to one of their chapter's projects, or put them straight on it; either
 * way the project's own rules apply (`projects.invite`, `projects.assign`).
 */
function OfferProject({ member }: { member: Member }) {
  const [projectId, setProjectId] = useState('')
  const [how, setHow] = useState<'invite' | 'add'>('invite')
  const [note, setNote] = useState('')
  const dialog = useDialog(() => {
    setProjectId('')
    setHow('invite')
    setNote('')
  })
  const {
    data: projects,
    isPending,
    isError,
  } = useQuery({
    ...orpc.admin.volunteers.projectsToOffer.queryOptions({ input: { volunteerId: member.id } }),
    enabled: dialog.open,
  })
  const options = useManaged(dialog.close)
  const invite = useMutation({ ...orpc.projects.invite.mutationOptions(), ...options })
  const add = useMutation({ ...orpc.projects.assign.mutationOptions(), ...options })
  const chosen = projects?.find((p) => String(p.id) === projectId)
  return (
    <>
      <Button variant="secondary" size="sm" onClick={dialog.show}>
        Invite to a project
      </Button>
      <ConfirmDialog
        id="offer-project-dialog"
        isOpen={dialog.open}
        title={`Invite ${member.name} to a project`}
        body={
          isPending ? (
            <p className="m-0">Loading projects…</p>
          ) : isError ? (
            <p className="m-0">Their projects could not be loaded. Close this and try again.</p>
          ) : projects.length === 0 ? (
            <p className="m-0">
              There is no live project in{' '}
              {member.chapterName ? `the ${member.chapterName} chapter` : 'the holding pool'} that
              they are not already on.
            </p>
          ) : (
            <div className="grid gap-3">
              <div>
                <FormLabel htmlFor="offer-project">Project</FormLabel>
                <Select
                  id="offer-project"
                  value={projectId}
                  onChange={(e) => setProjectId(e.target.value)}
                >
                  <option value="">Choose a project…</option>
                  {projects.map((p) => (
                    <option key={p.id} value={String(p.id)}>
                      {p.title}
                      {p.standing === 'applied' && ' (asked to join)'}
                      {p.standing === 'invited' && ' (invited already)'}
                    </option>
                  ))}
                </Select>
              </div>
              <fieldset className="m-0 p-0 border-0 grid gap-1">
                <legend className="mb-1">How</legend>
                <label className="flex gap-2 items-center">
                  <input
                    type="radio"
                    name="offer-how"
                    checked={how === 'invite'}
                    onChange={() => setHow('invite')}
                  />
                  Invite them: they accept or decline
                </label>
                <label className="flex gap-2 items-center">
                  <input
                    type="radio"
                    name="offer-how"
                    checked={how === 'add'}
                    onChange={() => setHow('add')}
                  />
                  Add them now, without asking
                </label>
              </fieldset>
              {how === 'invite' && (
                <div>
                  <FormLabel htmlFor="offer-note">Note (optional)</FormLabel>
                  <Textarea
                    id="offer-note"
                    rows={2}
                    maxLength={1000}
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                  />
                </div>
              )}
              {chosen?.standing === 'applied' && (
                <p className="m-0">They asked to join this one, so either way they are on it.</p>
              )}
            </div>
          )
        }
        confirmLabel={how === 'invite' ? 'Send invite' : 'Add to project'}
        confirmDisabled={!chosen || (how === 'invite' && chosen.standing === 'invited')}
        busy={invite.isPending || add.isPending}
        busyLabel="Saving…"
        onConfirm={() =>
          how === 'invite'
            ? invite.mutate({
                projectId: Number(projectId),
                volunteerId: member.id,
                message: note.trim() || null,
              })
            : add.mutate({ projectId: Number(projectId), volunteerId: member.id })
        }
        onClose={dialog.close}
      />
    </>
  )
}

/** Staff put a member on fast track (lib/fast-track.ts), or take them off it. */
function FastTrackToggle({ member, on }: { member: Member; on: boolean }) {
  const set = useMutation({
    ...orpc.volunteers.setFastTrack.mutationOptions(),
    ...useManaged(() => {}),
  })
  return (
    <Button
      variant="secondary"
      size="sm"
      disabled={set.isPending}
      onClick={() => set.mutate({ volunteerId: member.id, on: !on })}
    >
      {on ? 'Take off fast track' : `Fast track ${member.name}`}
    </Button>
  )
}

const POOL = 'pool'

function MoveChapter({
  member,
  control,
}: {
  member: Member
  control: NonNullable<Manage['moveChapter']>
}) {
  const [target, setTarget] = useState('')
  const dialog = useDialog(() => setTarget(''))
  const { data } = useQuery({ ...orpc.admin.chapters.list.queryOptions(), enabled: dialog.open })
  const move = useMutation({
    ...orpc.admin.chapters.reassign.mutationOptions(),
    ...useManaged(dialog.close),
  })
  const chapters = (data?.chapters ?? []).filter((c) => c.id !== control.chapterId)
  const poolOffered = control.chapterId !== null
  const targetName =
    target === POOL && poolOffered
      ? 'the holding pool'
      : chapters.find((c) => String(c.id) === target)?.name
  return (
    <>
      <Button variant="secondary" size="sm" onClick={dialog.show}>
        Move to another chapter
      </Button>
      <ConfirmDialog
        id="move-chapter-dialog"
        isOpen={dialog.open}
        title={`Move ${member.name} to another chapter?`}
        body={
          <>
            <FormLabel htmlFor="manage-move-to">Move to</FormLabel>
            <Select id="manage-move-to" value={target} onChange={(e) => setTarget(e.target.value)}>
              <option value="">Choose a chapter…</option>
              {chapters.map((c) => (
                <option key={c.id} value={String(c.id)}>
                  {c.name}
                </option>
              ))}
              {poolOffered && <option value={POOL}>Holding pool</option>}
            </Select>
            <p className="mb-0">
              They lose any chapter role, their local group and any pending transfer request. Their
              projects and teams stay as they are.
              {targetName && ` They join ${targetName}.`}
            </p>
          </>
        }
        confirmLabel="Move"
        busy={move.isPending}
        busyLabel="Moving…"
        confirmDisabled={!targetName}
        onConfirm={() =>
          move.mutate({
            volunteerId: member.id,
            chapterId: target === POOL ? null : Number(target),
          })
        }
        onClose={dialog.close}
      />
    </>
  )
}

/**
 * Everything the viewer may do to this member, grouped, each control shown only when the server
 * says they may (`manage` from `volunteers.getById`). Nothing renders without it.
 */
export default function MemberManage({
  member,
  manage,
  hasPicture,
}: {
  member: Member
  manage: Manage
  hasPicture: boolean
}) {
  const { chapterDeputy, chapterLead, coordinator, moveChapter } = manage
  const hasRoles = chapterDeputy || chapterLead || coordinator || moveChapter
  return (
    <section aria-labelledby="manage-heading" className={`${SECTION_CARD} mb-4`}>
      <H2 id="manage-heading" className="mt-0">
        Manage
      </H2>
      {hasRoles && (
        <div role="group" aria-labelledby="manage-roles" className="mb-4">
          <H3 id="manage-roles">Role and access</H3>
          <div className="flex flex-wrap gap-2">
            {chapterDeputy && <DeputyControl member={member} control={chapterDeputy} />}
            {chapterLead && (
              <LeadControl
                member={member}
                control={chapterLead}
                isDeputy={Boolean(chapterDeputy?.isDeputy)}
              />
            )}
            {coordinator && <CoordinatorControl member={member} control={coordinator} />}
            {moveChapter && <MoveChapter member={member} control={moveChapter} />}
          </div>
        </div>
      )}
      {manage.work && (
        <div role="group" aria-labelledby="manage-work" className="mb-4">
          <H3 id="manage-work">Work</H3>
          <div className="flex flex-wrap gap-2">
            <FastTrackToggle member={member} on={manage.fastTrack.on} />
            <VerifySkill member={member} />
            <OfferProject member={member} />
          </div>
        </div>
      )}
      <div role="group" aria-labelledby="manage-account">
        <H3 id="manage-account">Account</H3>
        <div className="flex flex-wrap gap-2">
          <Button href={`/admin/volunteers/${member.id}`} variant="secondary" size="sm">
            Admin record
          </Button>
          {hasPicture && <RemovePicture member={member} />}
        </div>
      </div>
    </section>
  )
}
