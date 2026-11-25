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
import PersonName from '@/components/PersonName'
import { formatDate } from '@/lib/format-date'
import type { ChapterAuditAction } from '@/generated/prisma/enums'

export type Manage = NonNullable<InferRouterOutputs<AppRouter>['volunteers']['getById']['manage']>

type Member = { id: number; name: string; chapterName: string | null }

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

/** Each audit action as it reads about the member it was done to; `chapter` is where. */
const DONE_TO_THEM: Record<ChapterAuditAction, (chapter: string) => string> = {
  CHAPTER_CREATED: () => 'opened a chapter',
  CHAPTER_UPDATED: () => 'changed a chapter',
  LEAD_APPOINTED: (c) => `made them lead of ${c}`,
  LEAD_REMOVED: (c) => `removed them as lead of ${c}`,
  DEPUTY_APPOINTED: (c) => `made them a deputy of ${c}`,
  DEPUTY_REMOVED: (c) => `removed them as a deputy of ${c}`,
  VOLUNTEER_REASSIGNED: (c) => `moved them to ${c}`,
  TRANSFER_APPROVED: (c) => `approved their move to ${c}`,
  TRANSFER_DECLINED: (c) => `declined their move to ${c}`,
  PROJECT_CHAPTER_CHANGED: () => 'moved one of their projects',
  TEAM_CHAPTER_CHANGED: () => 'moved one of their teams',
  ROLE_INVITE_SENT: (c) => `invited them to help run ${c}`,
  ROLE_INVITE_ACCEPTED: (c) => `accepted a role running ${c}`,
  JOINED_FROM_POOL: (c) => `joined ${c} from the holding pool`,
  COORDINATOR_APPOINTED: () => 'made them a coordinator',
  COORDINATOR_REMOVED: () => 'removed them as a coordinator',
  PROFILE_PICTURE_REMOVED: () => 'took down their profile picture',
}

/** What has been done to the member, read only once opened. */
function MemberHistory({ member }: { member: Member }) {
  const [open, setOpen] = useState(false)
  const { data: events, isError } = useQuery({
    ...orpc.admin.volunteers.history.queryOptions({ input: { volunteerId: member.id } }),
    enabled: open,
  })
  return (
    <details className="mt-4" onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary className="cursor-pointer font-semibold">History</summary>
      {isError ? (
        <p className="text-sm m-0 mt-2">Their history could not be loaded.</p>
      ) : !events ? (
        <p className="text-sm m-0 mt-2 text-text-light">Loading…</p>
      ) : events.length === 0 ? (
        <p className="text-sm m-0 mt-2 text-text-light">Nothing recorded yet.</p>
      ) : (
        <ul className="list-none p-0 m-0 mt-2 grid gap-1 text-sm">
          {events.map((e) => (
            <li key={e.id}>
              <span className="text-text-light">{formatDate(e.at)}</span>{' '}
              {e.actor ? <PersonName id={e.actor.id} name={e.actor.name} /> : 'Action Hub'}{' '}
              {DONE_TO_THEM[e.action](
                e.chapterName ? `the ${e.chapterName} chapter` : 'the holding pool',
              )}
            </li>
          ))}
        </ul>
      )}
    </details>
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
      <div role="group" aria-labelledby="manage-account">
        <H3 id="manage-account">Account</H3>
        <div className="flex flex-wrap gap-2">
          <Button href={`/admin/volunteers/${member.id}`} variant="secondary" size="sm">
            Admin record
          </Button>
          {hasPicture && <RemovePicture member={member} />}
        </div>
      </div>
      <MemberHistory member={member} />
    </section>
  )
}
