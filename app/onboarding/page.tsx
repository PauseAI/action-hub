'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationOptions,
} from '@tanstack/react-query'
import type { InferRouterOutputs } from '@orpc/server'
import type { AppRouter } from '@/server/router'
import { useAuth } from '@/lib/auth-context'
import { NO_ACCESS_NOTICE_URL } from '@/lib/hooks/auth'
import { orpc } from '@/lib/orpc'
import { useToast } from '@/lib/toast'
import { SECTION_CARD } from '@/lib/ui-classes'
import {
  DEFAULT_LUMA_DESCRIPTION,
  DEFAULT_LUMA_TITLE,
  describeSlot,
  formatCallTime,
} from '@/lib/onboarding'
import { Badge } from '@/components/Badge'
import Button from '@/components/Button'
import EmptyState from '@/components/EmptyState'
import FormLabel from '@/components/FormLabel'
import PageLoading from '@/components/PageLoading'
import Input from '@/components/ui/Input'
import Select from '@/components/ui/Select'
import Textarea from '@/components/ui/Textarea'
import { H1, H2, H3 } from '@/components/Heading'
import { P } from '@/components/Text'

type Overview = InferRouterOutputs<AppRouter>['onboarding']['overview']
type Call = Overview['calls'][number]

const errorText = (err: unknown) => (err instanceof Error ? err.message : 'Something went wrong')

/** "2026-12-02T14:00", read as UTC, as a `datetime-local` input gives it. */
const fromUtcInput = (value: string) => new Date(`${value}:00Z`)
const toUtcInput = (at: Date) => at.toISOString().slice(0, 16)

const localTime = (at: Date) =>
  at.toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' })

/** Every mutation here toasts its message and refreshes the page's one query. */
function useAction<I>(
  options: UseMutationOptions<{ message: string }, unknown, I> & { onDone?: () => void },
) {
  const showToast = useToast()
  const queryClient = useQueryClient()
  const { onDone, ...mutation } = options
  return useMutation({
    ...mutation,
    onSuccess: (data) => {
      showToast(data.message, 'success')
      onDone?.()
      void queryClient.invalidateQueries({ queryKey: orpc.onboarding.overview.key() })
    },
    onError: (err) => showToast(errorText(err), 'error'),
  })
}

function CallStatus({ call }: { call: Call }) {
  if (call.cancelled) return <Badge>Cancelled</Badge>
  if (!call.host) return <Badge variant="attention">Needs a host</Badge>
  if (call.coverRequested) return <Badge variant="attention">Cover needed</Badge>
  if (call.confirmed) return <Badge variant="success">Confirmed</Badge>
  return (
    <Badge variant="info" outline>
      Not confirmed yet
    </Badge>
  )
}

function ChangeTime({ call, onDone }: { call: Call; onDone: () => void }) {
  const [value, setValue] = useState(toUtcInput(new Date(call.startsAt)))
  const setTime = useAction({ ...orpc.onboarding.setTime.mutationOptions(), onDone })
  const id = `time-${call.id}`
  return (
    <form
      className="flex flex-wrap items-end gap-2 mt-3"
      onSubmit={(e) => {
        e.preventDefault()
        setTime.mutate({ callId: call.id, startsAt: fromUtcInput(value) })
      }}
    >
      <div>
        <FormLabel htmlFor={id}>New time (UTC)</FormLabel>
        <Input
          id={id}
          type="datetime-local"
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
      </div>
      <Button type="submit" size="sm" disabled={!value || setTime.isPending}>
        Save time
      </Button>
    </form>
  )
}

function CallCard({ call, overview }: { call: Call; overview: Overview }) {
  const [changingTime, setChangingTime] = useState(false)
  const [swapWith, setSwapWith] = useState('')
  const take = useAction(orpc.onboarding.take.mutationOptions())
  const confirm = useAction(orpc.onboarding.confirm.mutationOptions())
  const cover = useAction(orpc.onboarding.requestCover.mutationOptions())
  const cancel = useAction(orpc.onboarding.cancel.mutationOptions())
  const assign = useAction(orpc.onboarding.assign.mutationOptions())
  const swap = useAction({
    ...orpc.onboarding.swap.mutationOptions(),
    onDone: () => setSwapWith(''),
  })
  const startsAt = new Date(call.startsAt)
  const mine = call.host?.id === overview.me
  const canTake = !call.cancelled && overview.role !== null && !mine && call.takeable
  const swappable = overview.calls.filter(
    (c) => !c.cancelled && c.host && c.host.id !== overview.me,
  )
  const title = `${call.name}, ${formatCallTime(startsAt)}`

  return (
    <section
      aria-label={title}
      className={`${SECTION_CARD} mb-3 ${call.cancelled ? 'opacity-60' : ''}`}
    >
      <div className="flex flex-wrap justify-between items-start gap-2">
        <div>
          <H3 className="m-0">{title}</H3>
          <P className="text-text-light text-sm m-0">{localTime(startsAt)} your time</P>
        </div>
        <CallStatus call={call} />
      </div>
      <P className="mt-2 mb-0">
        {call.host ? (
          <>
            Host: <strong>{mine ? 'You' : call.host.name}</strong>
          </>
        ) : (
          'Nobody is hosting yet'
        )}
        {call.lumaGuests !== null && <> · {call.lumaGuests} registered</>}
        {call.lumaUrl && (
          <>
            {' · '}
            <a className="text-primary-text underline" href={call.lumaUrl}>
              Luma page
            </a>
          </>
        )}
      </P>
      {!call.cancelled && (
        <div className="flex flex-wrap gap-2 mt-3">
          {canTake && (
            <Button
              size="sm"
              disabled={take.isPending}
              onClick={() => take.mutate({ callId: call.id })}
            >
              I&apos;ll host
            </Button>
          )}
          {mine && !call.confirmed && (
            <Button
              size="sm"
              disabled={confirm.isPending}
              onClick={() => confirm.mutate({ callId: call.id })}
            >
              I&apos;m on
            </Button>
          )}
          {(mine || (overview.manages && call.host)) && !call.coverRequested && (
            <Button
              size="sm"
              variant="secondary"
              disabled={cover.isPending}
              onClick={() => cover.mutate({ callId: call.id })}
            >
              {mine ? 'I need cover' : 'Ask for cover'}
            </Button>
          )}
          {(mine || overview.manages) && (
            <Button size="sm" variant="ghost" onClick={() => setChangingTime((o) => !o)}>
              Change time
            </Button>
          )}
          {(overview.manages || (mine && call.hostMayCancel)) && (
            <Button
              size="sm"
              variant="warning"
              disabled={cancel.isPending}
              onClick={() => cancel.mutate({ callId: call.id })}
            >
              Cancel call
            </Button>
          )}
        </div>
      )}
      {mine && !call.cancelled && swappable.length > 0 && (
        <form
          className="flex flex-wrap items-end gap-2 mt-3"
          onSubmit={(e) => {
            e.preventDefault()
            swap.mutate({ callId: call.id, withCallId: Number(swapWith) })
          }}
        >
          <div>
            <FormLabel htmlFor={`swap-${call.id}`}>Swap with</FormLabel>
            <Select
              id={`swap-${call.id}`}
              value={swapWith}
              onChange={(e) => setSwapWith(e.target.value)}
            >
              <option value="">Pick a call</option>
              {swappable.map((c) => (
                <option key={c.id} value={c.id}>
                  {formatCallTime(new Date(c.startsAt))} ({c.host!.name})
                </option>
              ))}
            </Select>
          </div>
          <Button
            type="submit"
            size="sm"
            variant="secondary"
            disabled={!swapWith || swap.isPending}
          >
            Swap
          </Button>
        </form>
      )}
      {overview.manages && !call.cancelled && (
        <div className="mt-3 max-w-xs">
          <FormLabel htmlFor={`host-${call.id}`}>Host</FormLabel>
          <Select
            id={`host-${call.id}`}
            value={call.host?.id ?? ''}
            disabled={assign.isPending}
            onChange={(e) =>
              assign.mutate({
                callId: call.id,
                hostId: e.target.value ? Number(e.target.value) : null,
              })
            }
          >
            <option value="">Nobody</option>
            {overview.members.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </Select>
        </div>
      )}
      {changingTime && <ChangeTime call={call} onDone={() => setChangingTime(false)} />}
    </section>
  )
}

function AddCall() {
  const [name, setName] = useState('Call B')
  const [at, setAt] = useState('')
  const add = useAction({ ...orpc.onboarding.add.mutationOptions(), onDone: () => setAt('') })
  return (
    <form
      aria-label="Add a call"
      className={`${SECTION_CARD} flex flex-wrap items-end gap-3`}
      onSubmit={(e) => {
        e.preventDefault()
        add.mutate({ name, startsAt: fromUtcInput(at) })
      }}
    >
      <H3 className="w-full m-0">Add a one-off call</H3>
      <div>
        <FormLabel htmlFor="add-call-name">Name</FormLabel>
        <Input
          id="add-call-name"
          value={name}
          maxLength={100}
          onChange={(e) => setName(e.target.value)}
        />
      </div>
      <div>
        <FormLabel htmlFor="add-call-at">When (UTC)</FormLabel>
        <Input
          id="add-call-at"
          type="datetime-local"
          value={at}
          onChange={(e) => setAt(e.target.value)}
        />
      </div>
      <Button type="submit" size="sm" disabled={!name.trim() || !at || add.isPending}>
        Add call
      </Button>
    </form>
  )
}

type Slot = Overview['slots'][number]

/** One regular call's form: a new one when `slot` is undefined. */
function SlotForm({ slot, onDone }: { slot?: Slot; onDone?: () => void }) {
  const key = slot ? `slot-${slot.id}` : 'slot-new'
  const [name, setName] = useState(slot?.name ?? '')
  const [firstDay, setFirstDay] = useState(
    slot ? new Date(slot.firstDay).toISOString().slice(0, 10) : '',
  )
  const [everyWeeks, setEveryWeeks] = useState(String(slot?.everyWeeks ?? 2))
  const [time, setTime] = useState(slot?.time ?? '')
  const save = useAction({
    ...orpc.onboarding.saveSlot.mutationOptions(),
    onDone: () => {
      if (!slot) {
        setName('')
        setFirstDay('')
        setTime('')
      }
      onDone?.()
    },
  })
  return (
    <form
      aria-label={slot ? `Change ${slot.name}` : 'Add a regular call'}
      className={`${SECTION_CARD} flex flex-wrap items-end gap-3 mb-3`}
      onSubmit={(e) => {
        e.preventDefault()
        save.mutate({
          slotId: slot?.id,
          name,
          firstDay: new Date(`${firstDay}T00:00:00Z`),
          everyWeeks: Number(everyWeeks),
          time,
        })
      }}
    >
      <div>
        <FormLabel htmlFor={`${key}-name`}>Name</FormLabel>
        <Input
          id={`${key}-name`}
          value={name}
          maxLength={100}
          placeholder="Call A"
          onChange={(e) => setName(e.target.value)}
        />
      </div>
      <div>
        <FormLabel htmlFor={`${key}-first`}>First call</FormLabel>
        <Input
          id={`${key}-first`}
          type="date"
          value={firstDay}
          onChange={(e) => setFirstDay(e.target.value)}
        />
      </div>
      <div>
        <FormLabel htmlFor={`${key}-every`}>Repeats</FormLabel>
        <Select
          id={`${key}-every`}
          value={everyWeeks}
          onChange={(e) => setEveryWeeks(e.target.value)}
        >
          <option value="1">Every week</option>
          <option value="2">Every two weeks</option>
          <option value="3">Every three weeks</option>
          <option value="4">Every four weeks</option>
        </Select>
      </div>
      <div>
        <FormLabel htmlFor={`${key}-time`}>Time (UTC)</FormLabel>
        <Input
          id={`${key}-time`}
          type="time"
          value={time}
          onChange={(e) => setTime(e.target.value)}
        />
      </div>
      <Button
        type="submit"
        size="sm"
        disabled={!name.trim() || !firstDay || !time || save.isPending}
      >
        {slot ? 'Save' : 'Add regular call'}
      </Button>
    </form>
  )
}

function RegularCalls({ overview }: { overview: Overview }) {
  const [editing, setEditing] = useState<number | null>(null)
  const remove = useAction(orpc.onboarding.removeSlot.mutationOptions())
  return (
    <section aria-labelledby="regular-heading" className="mt-8">
      <H2 id="regular-heading">Regular calls</H2>
      <P className="text-text-light">
        Calls are made from these four weeks ahead and put on Luma. Changing one moves its coming
        calls that nobody hosts yet; a hosted call keeps its time.
      </P>
      {overview.slots.length === 0 && <EmptyState title="No regular calls yet" />}
      {overview.slots.map((s) =>
        editing === s.id ? (
          <SlotForm key={s.id} slot={s} onDone={() => setEditing(null)} />
        ) : (
          <div
            key={s.id}
            className={`${SECTION_CARD} mb-3 flex justify-between items-center gap-3`}
          >
            <div>
              <strong>{s.name}</strong>
              <P className="text-text-light text-sm m-0">
                {describeSlot({ ...s, firstDay: new Date(s.firstDay) })}
              </P>
            </div>
            <span className="flex gap-2">
              <Button
                size="sm"
                variant="ghost"
                aria-label={`Change ${s.name}`}
                onClick={() => setEditing(s.id)}
              >
                Change
              </Button>
              <Button
                size="sm"
                variant="warning"
                disabled={remove.isPending}
                aria-label={`Remove ${s.name}`}
                onClick={() => remove.mutate({ slotId: s.id })}
              >
                Remove
              </Button>
            </span>
          </div>
        ),
      )}
      <SlotForm />
    </section>
  )
}

function Settings({ overview }: { overview: Overview }) {
  const [meetLink, setMeetLink] = useState(overview.settings.meetLink ?? '')
  const [title, setTitle] = useState(overview.settings.lumaTitle ?? '')
  const [description, setDescription] = useState(overview.settings.lumaDescription ?? '')
  const save = useAction(orpc.onboarding.saveSettings.mutationOptions())
  return (
    <form
      aria-labelledby="settings-heading"
      className={`${SECTION_CARD} mt-8`}
      onSubmit={(e) => {
        e.preventDefault()
        save.mutate({
          meetLink: meetLink.trim() || null,
          lumaTitle: title.trim() || null,
          lumaDescription: description.trim() || null,
        })
      }}
    >
      <H2 id="settings-heading">Every call</H2>
      <FormLabel htmlFor="meet-link">Google Meet link</FormLabel>
      <Input
        id="meet-link"
        type="url"
        value={meetLink}
        placeholder="https://meet.google.com/…"
        onChange={(e) => setMeetLink(e.target.value)}
      />
      <FormLabel htmlFor="luma-title" className="mt-3">
        Title on Luma
      </FormLabel>
      <Input
        id="luma-title"
        value={title}
        maxLength={200}
        placeholder={DEFAULT_LUMA_TITLE}
        onChange={(e) => setTitle(e.target.value)}
      />
      <FormLabel htmlFor="luma-description" className="mt-3">
        Description on Luma
      </FormLabel>
      <Textarea
        id="luma-description"
        rows={5}
        value={description}
        maxLength={5000}
        placeholder={DEFAULT_LUMA_DESCRIPTION}
        onChange={(e) => setDescription(e.target.value)}
      />
      <Button type="submit" size="sm" className="mt-3" disabled={save.isPending}>
        Save
      </Button>
    </form>
  )
}

const ROLE_LABEL = { LEAD: 'Lead', DEPUTY: 'Deputy', MEMBER: null } as const

function Team({ overview }: { overview: Overview }) {
  const [email, setEmail] = useState('')
  const [leadEmail, setLeadEmail] = useState('')
  const add = useAction({
    ...orpc.onboarding.addMember.mutationOptions(),
    onDone: () => setEmail(''),
  })
  const remove = useAction(orpc.onboarding.removeMember.mutationOptions())
  const setRole = useAction(orpc.onboarding.setRole.mutationOptions())
  const setLead = useAction({
    ...orpc.onboarding.setLead.mutationOptions(),
    onDone: () => setLeadEmail(''),
  })
  const namesDeputies = overview.role === 'LEAD' || overview.isAdmin
  return (
    <section aria-labelledby="team-heading" className="mt-8">
      <H2 id="team-heading">The team</H2>
      <ul className="list-none p-0">
        {overview.members.map((m) => (
          <li
            key={m.id}
            className={`${SECTION_CARD} mb-2 flex flex-wrap justify-between items-center gap-3`}
          >
            <span>
              <strong>{m.name}</strong>
              {ROLE_LABEL[m.role] && (
                <span className="text-text-light"> · {ROLE_LABEL[m.role]}</span>
              )}
            </span>
            {overview.manages && m.role !== 'LEAD' && m.id !== overview.me && (
              <span className="flex gap-2">
                {namesDeputies && (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={setRole.isPending}
                    onClick={() =>
                      setRole.mutate({
                        volunteerId: m.id,
                        role: m.role === 'DEPUTY' ? 'MEMBER' : 'DEPUTY',
                      })
                    }
                  >
                    {m.role === 'DEPUTY' ? 'Make member' : 'Make deputy'}
                  </Button>
                )}
                {(namesDeputies || m.role === 'MEMBER') && (
                  <Button
                    size="sm"
                    variant="warning"
                    disabled={remove.isPending}
                    aria-label={`Remove ${m.name} from the team`}
                    onClick={() => remove.mutate({ volunteerId: m.id })}
                  >
                    Remove
                  </Button>
                )}
              </span>
            )}
          </li>
        ))}
      </ul>
      {overview.manages && (
        <form
          aria-label="Add to the team"
          className={`${SECTION_CARD} flex flex-wrap items-end gap-3`}
          onSubmit={(e) => {
            e.preventDefault()
            add.mutate({ email: email.trim() })
          }}
        >
          <div className="flex-1 min-w-60">
            <FormLabel htmlFor="member-email">Add someone by their Action Hub email</FormLabel>
            <Input
              id="member-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <Button type="submit" size="sm" disabled={!email.trim() || add.isPending}>
            Add to team
          </Button>
        </form>
      )}
      {overview.isAdmin && (
        <form
          aria-label="Set the lead"
          className={`${SECTION_CARD} flex flex-wrap items-end gap-3 mt-3`}
          onSubmit={(e) => {
            e.preventDefault()
            setLead.mutate({ email: leadEmail.trim() })
          }}
        >
          <div className="flex-1 min-w-60">
            <FormLabel htmlFor="lead-email">Make lead (global admins only)</FormLabel>
            <Input
              id="lead-email"
              type="email"
              value={leadEmail}
              onChange={(e) => setLeadEmail(e.target.value)}
            />
          </div>
          <Button type="submit" size="sm" disabled={!leadEmail.trim() || setLead.isPending}>
            Make lead
          </Button>
        </form>
      )}
    </section>
  )
}

export default function OnboardingPage() {
  const router = useRouter()
  const { user, loading } = useAuth()
  const allowed = Boolean(user && (user.onboardingRole || user.access.globalAdmin))
  useEffect(() => {
    if (!loading && !user) router.replace('/login')
    else if (!loading && !allowed) router.replace(NO_ACCESS_NOTICE_URL)
  }, [loading, user, allowed, router])
  const { data: overview } = useQuery({
    ...orpc.onboarding.overview.queryOptions(),
    enabled: allowed,
  })

  if (loading || !allowed || !overview) return <PageLoading />

  return (
    <main className="container py-5 pb-15">
      <H1>Global Onboarding</H1>
      <P className="text-text-light">
        Welcome calls for new volunteers. Take a call you can host; a few days before, you&apos;ll
        get an email asking if you&apos;re on. If you can&apos;t make it, ask for cover and the rest
        of the team is asked. Luma updates itself.
      </P>
      {overview.settings.meetLink && (
        <P>
          Every call is on{' '}
          <a className="text-primary-text underline" href={overview.settings.meetLink}>
            {overview.settings.meetLink}
          </a>
        </P>
      )}
      {!overview.lumaLive && (
        <P role="note" className="text-text-light text-sm">
          This copy of Action Hub doesn&apos;t talk to Luma, so calls here are not published.
        </P>
      )}
      <H2>Upcoming calls</H2>
      {overview.calls.length === 0 ? (
        <EmptyState title="No calls coming up" />
      ) : (
        overview.calls.map((c) => <CallCard key={c.id} call={c} overview={overview} />)
      )}
      {overview.manages && (
        <>
          <AddCall />
          <RegularCalls overview={overview} />
          <Settings overview={overview} />
        </>
      )}
      <Team overview={overview} />
    </main>
  )
}
