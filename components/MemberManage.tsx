'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
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
import { OVERLAP_LABELS } from '@/lib/account-overlap'
import Textarea from '@/components/ui/Textarea'
import { formatDate } from '@/lib/format-date'
import PersonName from '@/components/PersonName'
import type { ChapterAuditAction } from '@/generated/prisma/enums'

export type Manage = NonNullable<InferRouterOutputs<AppRouter>['volunteers']['getById']['manage']>
export type Move = NonNullable<InferRouterOutputs<AppRouter>['volunteers']['getById']['move']>

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

/** A merge of this account waiting for proof, with the answer this admin may give. */
function PendingMerge({ pending }: { pending: NonNullable<Manage['merge']>['pending'] }) {
  const options = useManaged(() => {})
  const approve = useMutation({
    ...orpc.admin.volunteers.approveMerge.mutationOptions(),
    ...options,
  })
  const withdraw = useMutation({
    ...orpc.admin.volunteers.withdrawMerge.mutationOptions(),
    ...options,
  })
  if (!pending) return null
  const busy = approve.isPending || withdraw.isPending
  return (
    <div role="status" className="w-full text-sm">
      <p className="m-0 mb-2">
        Waiting: merging {pending.mergedName}&apos;s account into {pending.keptName}&apos;s, asked
        by {pending.requestedByName ?? 'a global admin'}, until{' '}
        {pending.gate === 'MAILBOXES'
          ? 'the links sent to both addresses are followed.'
          : 'another global admin approves it.'}
      </p>
      <div className="flex flex-wrap gap-2">
        {pending.canApprove && (
          <Button size="sm" disabled={busy} onClick={() => approve.mutate({ id: pending.id })}>
            Approve merge
          </Button>
        )}
        <Button
          size="sm"
          variant="secondary"
          disabled={busy}
          onClick={() => withdraw.mutate({ id: pending.id })}
        >
          Withdraw merge request
        </Button>
      </div>
    </div>
  )
}

/**
 * Folds this account and one that looks like the same person's into one. Offered only where the
 * two share more than a name, listed in the confirm step; it cannot be undone.
 */
function MergeAccounts({
  member,
  merge: control,
}: {
  member: Member
  merge: NonNullable<Manage['merge']>
}) {
  const [otherId, setOtherId] = useState('')
  const [keepThis, setKeepThis] = useState(true)
  const dialog = useDialog(() => {
    setOtherId('')
    setKeepThis(true)
  })
  const { data: candidates, isError } = useQuery({
    ...orpc.admin.volunteers.mergeCandidates.queryOptions({ input: { volunteerId: member.id } }),
    enabled: dialog.open,
  })
  const router = useRouter()
  const managed = useManaged(dialog.close)
  const merge = useMutation({
    ...orpc.admin.volunteers.merge.mutationOptions(),
    ...managed,
    onSuccess: (result, { keptId, mergedId }) => {
      managed.onSuccess(result)
      // This profile's account is closed once merged away; its person lives on at the other.
      if (mergedId === member.id) router.push(`/volunteers/${keptId}`)
    },
  })
  const choose = (c: { id: number; mustKeep: 'this' | 'other' | null; keepOther: boolean }) => {
    setOtherId(String(c.id))
    setKeepThis(c.mustKeep ? c.mustKeep === 'this' : !c.keepOther)
  }
  const other = candidates?.find((c) => String(c.id) === otherId)
  const kept = other && (keepThis ? member.name : other.name)
  const outcome = !kept
    ? 'Choose the account that is the same person.'
    : other.gated
      ? `They share nothing that shows one person holds both, so we first ask for proof: a link to each address, merged once both are followed, or, where an account has no confirmed address, another global admin's approval. Then everything moves to ${kept}'s account.`
      : `Everything moves to ${kept}'s account; the other is closed. They sign in with a confirmed address, and each address is emailed. This cannot be undone.`
  return (
    <>
      <PendingMerge pending={control.pending} />
      <Button variant="danger" size="sm" onClick={dialog.show}>
        Merge with another account
      </Button>
      <ConfirmDialog
        id="merge-dialog"
        isOpen={dialog.open}
        title={`Merge ${member.name}'s account with another?`}
        body={
          isError ? (
            <p className="m-0">The accounts could not be loaded. Close this and try again.</p>
          ) : !candidates ? (
            <p className="m-0">Looking for accounts that look like the same person…</p>
          ) : candidates.length === 0 ? (
            <p className="m-0">
              No account looks like the same person: none shares a name, Discord handle, number or
              mailbox with this one, or is marked as its duplicate.
            </p>
          ) : (
            <div className="grid gap-3">
              <fieldset className="m-0 p-0 border-0 grid gap-1">
                <legend className="mb-1">The other account</legend>
                {candidates.map((c) => (
                  <label key={c.id} className="flex gap-2 items-start">
                    <input
                      type="radio"
                      name="merge-other"
                      checked={otherId === String(c.id)}
                      onChange={() => choose(c)}
                    />
                    <span>
                      {c.name}
                      {c.chapterName && ` (${c.chapterName})`}
                      <span className="block text-sm">
                        {c.gated && !c.overlap.length
                          ? 'Marked as the same person, sharing nothing'
                          : c.overlap.map((o) => OVERLAP_LABELS[o]).join(' · ')}
                        {c.gated && ' (needs proof first)'}
                      </span>
                    </span>
                  </label>
                ))}
              </fieldset>
              {other && (
                <fieldset className="m-0 p-0 border-0 grid gap-1" disabled={!!other.mustKeep}>
                  <legend className="mb-1">
                    Keep{other.mustKeep && ' (the one that holds a role stays)'}
                  </legend>
                  <label className="flex gap-2 items-center">
                    <input
                      type="radio"
                      name="merge-keep"
                      checked={keepThis}
                      onChange={() => setKeepThis(true)}
                    />
                    This account ({member.name})
                  </label>
                  <label className="flex gap-2 items-center">
                    <input
                      type="radio"
                      name="merge-keep"
                      checked={!keepThis}
                      onChange={() => setKeepThis(false)}
                    />
                    {other.name}&apos;s
                  </label>
                </fieldset>
              )}
              <p className="m-0">{outcome}</p>
            </div>
          )
        }
        confirmLabel={other?.gated ? 'Ask for proof' : 'Merge accounts'}
        confirmDisabled={!other}
        danger
        busy={merge.isPending}
        busyLabel="Merging…"
        onConfirm={() =>
          merge.mutate({
            keptId: keepThis ? member.id : Number(otherId),
            mergedId: keepThis ? Number(otherId) : member.id,
          })
        }
        onClose={dialog.close}
      />
    </>
  )
}

/** Ends every session a member has, for when their account may be in someone else's hands. */
function SignOutEverywhere({
  member,
  control,
}: {
  member: Member
  control: NonNullable<Manage['signOutEverywhere']>
}) {
  const dialog = useDialog()
  const signOut = useMutation({
    ...orpc.admin.volunteers.signOutEverywhere.mutationOptions(),
    ...useManaged(dialog.close),
  })
  const signedIn = control.signedIn
    ? `${member.name} is signed in.`
    : `${member.name} is not signed in anywhere right now.`
  const tokens =
    control.apiTokens > 0
      ? ` Their ${control.apiTokens === 1 ? 'API token stops' : `${control.apiTokens} API tokens stop`} working too.`
      : ''
  return (
    <>
      <Button variant="secondary" size="sm" onClick={dialog.show}>
        Sign out everywhere
      </Button>
      <ConfirmDialog
        id="sign-out-dialog"
        isOpen={dialog.open}
        title={`Sign ${member.name} out everywhere?`}
        body={`${signedIn}${tokens} Every session ends at once, as when an account may be in someone else's hands, and they are emailed to say so. It does not change their password: if someone else may know it, they should change it once they sign in again.`}
        confirmLabel="Sign out everywhere"
        danger
        busy={signOut.isPending}
        busyLabel="Signing out…"
        onConfirm={() => signOut.mutate({ volunteerId: member.id })}
        onClose={dialog.close}
      />
    </>
  )
}

/**
 * Suspends a member, with the reason on record for staff, or shows the suspension and lifts it.
 * The member is emailed either way, never the reason.
 */
function Suspend({ member, control }: { member: Member; control: NonNullable<Manage['suspend']> }) {
  const [reason, setReason] = useState('')
  const dialog = useDialog(() => setReason(''))
  const set = useMutation({
    ...orpc.admin.volunteers.setSuspended.mutationOptions(),
    ...useManaged(dialog.close),
  })
  const { suspension } = control
  if (suspension) {
    return (
      <div role="status" className="w-full text-sm">
        <p className="m-0 mb-2">
          <strong>Suspended</strong> on {formatDate(suspension.at)}
          {suspension.byName && ` by ${suspension.byName}`}
          {suspension.reason && `: ${suspension.reason}`}
        </p>
        <Button size="sm" variant="secondary" onClick={dialog.show}>
          Lift suspension
        </Button>
        <ConfirmDialog
          id="lift-suspension-dialog"
          isOpen={dialog.open}
          title={`Lift ${member.name}'s suspension?`}
          body={`${member.name} can sign in again, with everything as they left it, and is emailed to say so.`}
          confirmLabel="Lift suspension"
          busy={set.isPending}
          busyLabel="Saving…"
          onConfirm={() => set.mutate({ volunteerId: member.id, suspended: false })}
          onClose={dialog.close}
        />
      </div>
    )
  }
  return (
    <>
      <Button variant="danger" size="sm" onClick={dialog.show}>
        Suspend
      </Button>
      <ConfirmDialog
        id="suspend-dialog"
        isOpen={dialog.open}
        title={`Suspend ${member.name}?`}
        body={
          <div className="grid gap-3">
            <p className="m-0">
              They are signed out and cannot sign in, and drop out of the directory, pickers, calls
              and email. Nothing is deleted, and their tasks stay theirs until someone reassigns
              them. They are emailed kindly, without your reason. Their chapter&apos;s staff and the
              global admins are told, with it.
            </p>
            <div>
              <FormLabel htmlFor="suspend-reason">Why</FormLabel>
              <p id="suspend-reason-hint" className="m-0 mb-1 text-sm">
                Kept on record. It is not in the email to them but, like an admin note, it is in
                their copy of their own data if they ask for it.
              </p>
              <Textarea
                id="suspend-reason"
                aria-describedby="suspend-reason-hint"
                rows={3}
                maxLength={1000}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
            </div>
          </div>
        }
        confirmLabel="Suspend"
        confirmDisabled={reason.trim().length < 3}
        danger
        busy={set.isPending}
        busyLabel="Suspending…"
        onConfirm={() =>
          set.mutate({ volunteerId: member.id, suspended: true, reason: reason.trim() })
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
  APPLICATION_REVIEW_STARTED: () => 'started reviewing their application',
  APPLICATION_INFO_REQUESTED: () => 'asked them for more about their application',
  APPLICATION_REJECTED: () => 'rejected their application',
  APPLICATION_REOPENED: () => 'reopened their application',
  APPLICATION_APPROVED: () => 'approved their application',
  SESSIONS_REVOKED: () => 'signed them out everywhere',
  MEMBER_SUSPENDED: () => 'suspended them',
  MEMBER_UNSUSPENDED: () => 'lifted their suspension',
  ACCOUNT_MERGED: () => 'merged another account into theirs',
  TRANSFER_REQUESTED: (c) => `asked, for ${c}, to move them`,
}

const INTO_POOL = new Set<ChapterAuditAction>([
  'VOLUNTEER_REASSIGNED',
  'TRANSFER_APPROVED',
  'TRANSFER_DECLINED',
])

/** What has been done to the member, read only once opened. */
function MemberHistory({ member }: { member: Member }) {
  const [open, setOpen] = useState(false)
  const { data, isError } = useQuery({
    ...orpc.admin.volunteers.history.queryOptions({ input: { volunteerId: member.id } }),
    enabled: open,
  })
  return (
    <details className="mt-4" onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary className="cursor-pointer font-semibold">History</summary>
      {isError ? (
        <p className="text-sm m-0 mt-2">Their history could not be loaded.</p>
      ) : !data ? (
        <p className="text-sm m-0 mt-2 text-text-light">Loading…</p>
      ) : data.events.length === 0 ? (
        <p className="text-sm m-0 mt-2 text-text-light">Nothing recorded yet.</p>
      ) : (
        <ul className="list-none p-0 m-0 mt-2 grid gap-1 text-sm">
          {data.events.map((e) => (
            <li key={e.id}>
              <span className="text-text-light">{formatDate(e.at)}</span>{' '}
              {e.actor ? <PersonName id={e.actor.id} name={e.actor.name} /> : 'Action Hub'}{' '}
              {DONE_TO_THEM[e.action](
                e.chapterName
                  ? `the ${e.chapterName} chapter`
                  : // Only a move can be to the pool; anything else lost its chapter since.
                    INTO_POOL.has(e.action)
                    ? 'the holding pool'
                    : 'a chapter since closed',
              )}
            </li>
          ))}
          {data.more && <li className="text-text-light">Older entries are not shown.</li>}
        </ul>
      )}
    </details>
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
 * A chapter's lead or deputies ask another chapter to take their member, or move them to the
 * holding pool at once; another chapter's staff ask to bring them in. The other side answers.
 */
function AskToMove({ member, move }: { member: Member; move: Move }) {
  const [target, setTarget] = useState('')
  const [reason, setReason] = useState('')
  const dialog = useDialog(() => {
    setTarget('')
    setReason('')
  })
  const { data } = useQuery({
    ...orpc.chapters.list.queryOptions(),
    enabled: dialog.open && move.send,
  })
  const ask = useMutation({
    ...orpc.chapterTransfers.requestFor.mutationOptions(),
    ...useManaged(dialog.close),
  })
  const bring = move.bringInto
  const chapters = (data ?? []).filter((c) => c.name !== member.chapterName)
  const chosen = chapters.find((c) => String(c.id) === target)
  const toPool = target === 'pool'
  return (
    <>
      <Button variant="secondary" size="sm" onClick={dialog.show}>
        {bring ? `Ask to bring into ${bring.name}` : 'Ask to move to another chapter'}
      </Button>
      <ConfirmDialog
        id="ask-move-dialog"
        isOpen={dialog.open}
        title={bring ? `Bring ${member.name} into ${bring.name}?` : `Move ${member.name} on?`}
        body={
          <div className="grid gap-3">
            {bring ? (
              <p className="m-0">
                {member.chapterName
                  ? `The ${member.chapterName} chapter's lead or deputies are asked.`
                  : 'The global admins, who look after the holding pool, are asked.'}{' '}
                {member.name} moves once they agree, and is told then.
              </p>
            ) : (
              <>
                <div>
                  <FormLabel htmlFor="ask-move-to">Move to</FormLabel>
                  <Select
                    id="ask-move-to"
                    value={target}
                    onChange={(e) => setTarget(e.target.value)}
                  >
                    <option value="">Choose a chapter…</option>
                    {chapters.map((c) => (
                      <option key={c.id} value={String(c.id)}>
                        {c.name}
                      </option>
                    ))}
                    {move.toPool && <option value="pool">Holding pool (no chapter)</option>}
                  </Select>
                </div>
                <p className="m-0">
                  {toPool
                    ? `${member.name} moves out at once and is told. They lose any staff role and local group, and keep their projects and teams.`
                    : chosen
                      ? `The ${chosen.name} chapter's staff are asked. ${member.name} moves once they agree, and is told then.`
                      : 'The chapter you choose is asked to take them.'}
                </p>
              </>
            )}
            {!toPool && (
              <div>
                <FormLabel htmlFor="ask-move-reason">Why (optional)</FormLabel>
                <Textarea
                  id="ask-move-reason"
                  rows={2}
                  maxLength={1000}
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                />
              </div>
            )}
          </div>
        }
        confirmLabel={toPool ? 'Move to holding pool' : 'Ask'}
        confirmDisabled={!bring && !chosen && !toPool}
        busy={ask.isPending}
        busyLabel="Saving…"
        onConfirm={() =>
          ask.mutate({
            volunteerId: member.id,
            toChapterId: bring ? bring.id : toPool ? null : Number(target),
            reason: reason.trim() || null,
          })
        }
        onClose={dialog.close}
      />
    </>
  )
}

/** A move already waiting: who asked, and the answer or withdrawal this viewer may give. */
function PendingMove({
  member,
  pending,
}: {
  member: Member
  pending: NonNullable<Move['pending']>
}) {
  const options = useManaged(() => {})
  const decide = useMutation({ ...orpc.chapterTransfers.decide.mutationOptions(), ...options })
  const withdraw = useMutation({ ...orpc.chapterTransfers.withdraw.mutationOptions(), ...options })
  const from = pending.fromChapterName ?? 'the holding pool'
  const to = pending.toChapterName ?? 'the holding pool'
  const who = pending.requestedByName ?? member.name
  const busy = decide.isPending || withdraw.isPending
  return (
    <div className="w-full">
      <p className="m-0 mb-2 text-sm">
        Waiting: a move from {from} to {to}, asked by {who}.
      </p>
      <div className="flex flex-wrap gap-2">
        {pending.canAnswer && (
          <>
            <Button
              size="sm"
              disabled={busy}
              onClick={() => decide.mutate({ id: pending.id, approve: true })}
            >
              Accept move
            </Button>
            <Button
              size="sm"
              variant="secondary"
              disabled={busy}
              onClick={() => decide.mutate({ id: pending.id, approve: false })}
            >
              Decline move
            </Button>
          </>
        )}
        {pending.canWithdraw && (
          <Button
            size="sm"
            variant="secondary"
            disabled={busy}
            onClick={() => withdraw.mutate({ id: pending.id })}
          >
            Withdraw request
          </Button>
        )}
      </div>
    </div>
  )
}

/**
 * Everything the viewer may do to this member, grouped, each control shown only when the server
 * says they may (`manage` and `move` from `volunteers.getById`).
 */
export default function MemberManage({
  member,
  manage,
  move,
  hasPicture,
}: {
  member: Member
  /** Null for staff of another chapter, who may only ask to bring the member in. */
  manage: Manage | null
  move: Move | null
  hasPicture: boolean
}) {
  const { chapterDeputy, chapterLead, coordinator, moveChapter } = manage ?? {}
  const asks = move && (move.send || move.toPool || move.bringInto) && !move.pending
  const hasRoles =
    chapterDeputy || chapterLead || coordinator || moveChapter || asks || move?.pending
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
            {asks && <AskToMove member={member} move={move} />}
            {move?.pending && <PendingMove member={member} pending={move.pending} />}
          </div>
        </div>
      )}
      {manage?.work && (
        <div role="group" aria-labelledby="manage-work" className="mb-4">
          <H3 id="manage-work">Work</H3>
          <div className="flex flex-wrap gap-2">
            <FastTrackToggle member={member} on={manage.fastTrack.on} />
            <VerifySkill member={member} />
            <OfferProject member={member} />
          </div>
        </div>
      )}
      {manage && (
        <div role="group" aria-labelledby="manage-account">
          <H3 id="manage-account">Account</H3>
          <div className="flex flex-wrap gap-2">
            <Button href={`/admin/volunteers/${member.id}`} variant="secondary" size="sm">
              Admin record
            </Button>
            {manage.suspend && <Suspend member={member} control={manage.suspend} />}
            {manage.signOutEverywhere && (
              <SignOutEverywhere member={member} control={manage.signOutEverywhere} />
            )}
            {hasPicture && manage.removePicture && <RemovePicture member={member} />}
            {manage.merge && <MergeAccounts member={member} merge={manage.merge} />}
          </div>
        </div>
      )}
      {manage && <MemberHistory member={member} />}
    </section>
  )
}
