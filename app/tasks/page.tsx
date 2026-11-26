'use client'

import React, { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { InferRouterOutputs } from '@orpc/server'
import { useRequireApproved } from '@/lib/hooks/auth'
import Button from '@/components/Button'
import { H1, H2, H3 } from '@/components/Heading'
import { P } from '@/components/Text'
import Linkify from '@/components/Linkify'
import AskForHelpButton from '@/components/AskForHelpButton'
import { DueChip, WorkStatusBadge } from '@/components/StatusBadges'
import PageLoading from '@/components/PageLoading'
import Skeleton from '@/components/Skeleton'
import EmptyState from '@/components/EmptyState'
import Tabs from '@/components/Tabs'
import { PROJECT_TASK_CLAIMED_MESSAGE, TASK_REQUESTED_MESSAGE } from '@/lib/action-messages'
import { CLAIM_TASK, CLAIMING, claimLabel, joinAsHelperLabel } from '@/lib/action-labels'
import { askingFor, offeredSummary } from '@/lib/helper-summary'
import type { WorkViewer } from '@/lib/status-emphasis'
import { orpc } from '@/lib/orpc'
import { useToast } from '@/lib/toast'
import { handedIn } from '@/lib/overdue'
import { SECTION_CARD } from '@/lib/ui-classes'
import { TaskStatus } from '@/generated/prisma/enums'
import type { AppRouter } from '@/server/router'

type Outputs = InferRouterOutputs<AppRouter>
type MyRequest = Outputs['requests']['mine'][number]
type HeldTask = Outputs['my']['projectTasks'][number]

const CHIP = 'inline-flex items-center px-3 py-1 bg-chip text-chip-text rounded-full text-sm'

const ONLOOKER: WorkViewer = { isAssignee: false, canReview: false }
const DOER: WorkViewer = { isAssignee: true, canReview: false }
/** Whoever asked for help reviews the work on their request. */
const ASKER: WorkViewer = { isAssignee: false, canReview: true }

/** One piece of work: its title and status, what it is part of, and what can be done to it. */
function TaskCard({
  title,
  href,
  status,
  viewer,
  meta,
  description,
  children,
}: {
  title: string
  href: string
  status: string
  viewer: WorkViewer
  meta: React.ReactNode[]
  description?: string | null
  children?: React.ReactNode
}) {
  return (
    <div role="article" className={`${SECTION_CARD} mb-4 overflow-hidden wrap-break-word`}>
      <div className="flex justify-between items-start gap-3 mb-2">
        <H3 className="m-0">
          <Link className="text-primary-text underline" href={href}>
            {title}
          </Link>
        </H3>
        <WorkStatusBadge
          status={status}
          viewer={viewer}
          role="status"
          className="whitespace-nowrap shrink-0"
        />
      </div>
      {meta.some(Boolean) && <div className="flex gap-2 mb-3 flex-wrap items-center">{meta}</div>}
      {description && (
        <P className="whitespace-pre-wrap mb-4">
          <Linkify text={description} />
        </P>
      )}
      {children}
    </div>
  )
}

const taskHref = (t: { projectId: number | null; id: number }) =>
  `/projects/${t.projectId}/tasks/${t.id}`

function PartOf({ projectId, title }: { projectId: number; title: string }) {
  return (
    <span className="text-text-light text-sm">
      Part of:{' '}
      <Link className="text-primary-text underline" href={`/projects/${projectId}`}>
        {title}
      </Link>
    </span>
  )
}

export default function TasksPage() {
  const { user, loading } = useRequireApproved()
  if (loading || !user) return <PageLoading />
  return <TasksFeed userId={user.id} chapterName={user.chapter?.name ?? null} />
}

/**
 * The work anyone can take now (requests for help, featured tasks and helper places), and,
 * under Mine, the requests the viewer asked for and the tasks they hold.
 */
function TasksFeed({ userId, chapterName }: { userId: number; chapterName: string | null }) {
  const showToast = useToast()
  const queryClient = useQueryClient()
  const router = useRouter()

  const { data: feed = [], isLoading: loadingFeed } = useQuery(orpc.requests.feed.queryOptions())
  const { data: myRequests = [] } = useQuery(orpc.requests.mine.queryOptions())
  const { data: held = [] } = useQuery(orpc.my.projectTasks.queryOptions())

  // Requests already done stay listed, but don't count as something on your plate.
  const mineCount = held.length + myRequests.filter((r) => r.status !== TaskStatus.completed).length
  const [chosenTab, setChosenTab] = useState<'mine' | 'open' | null>(null)
  const tab = chosenTab ?? (mineCount > 0 ? 'mine' : 'open')

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: orpc.requests.key() })
    void queryClient.invalidateQueries({ queryKey: orpc.my.projectTasks.key() })
  }

  const claim = useMutation({
    ...orpc.projects.updateTask.mutationOptions(),
    onSuccess: (data, variables) => {
      showToast(data.requested ? TASK_REQUESTED_MESSAGE : PROJECT_TASK_CLAIMED_MESSAGE, 'success')
      refresh()
      router.push(`/projects/${variables.projectId}/tasks/${variables.taskId}`)
    },
    onError: (err: unknown) =>
      showToast(err instanceof Error ? err.message : 'Failed to claim task', 'error'),
  })
  const claiming = (taskId: number) => claim.isPending && claim.variables?.taskId === taskId
  const take = (t: { projectId: number; id: number }) =>
    claim.mutate({ projectId: t.projectId, taskId: t.id, data: { assigneeId: userId } })

  const offer = useMutation({
    ...orpc.projects.expressInterest.mutationOptions(),
    onSuccess: (data, variables) => {
      showToast(data.message, 'success')
      refresh()
      router.push(`/projects/${variables.projectId}/tasks/${variables.taskId}`)
    },
    onError: (err: unknown) =>
      showToast(err instanceof Error ? err.message : 'Failed to offer help', 'error'),
  })

  const due = (deadline: Date | null, viewer: WorkViewer, done = false) =>
    deadline && (
      <DueChip key="deadline" deadline={deadline} done={done} viewer={viewer} className="text-sm" />
    )
  const hours = (h: number | null) =>
    h !== null && (
      <span key="hours" className="text-text-light text-sm">
        ~{h}h
      </span>
    )

  return (
    <main className="container py-5 pb-15">
      <div className="flex justify-between items-center gap-3 flex-wrap mb-3">
        <H1 className="m-0">Tasks</H1>
        <AskForHelpButton chapterName={chapterName} />
      </div>
      <P className="text-text-light mb-4">
        Work you can take now, no need to browse projects first, and help you can ask for.
      </P>
      <Tabs
        tabs={[
          { key: 'open', label: `Open${feed.length ? ` (${feed.length})` : ''}` },
          { key: 'mine', label: `Mine${mineCount ? ` (${mineCount})` : ''}` },
        ]}
        activeTab={tab}
        onChange={setChosenTab}
      />

      {tab === 'open' && (
        <section aria-labelledby="open-tasks">
          <H2 id="open-tasks" className="mt-0">
            Open to take
          </H2>
          {loadingFeed ? (
            <Skeleton label="Loading tasks…" />
          ) : feed.length === 0 ? (
            <EmptyState
              title="Nothing open right now"
              body="Ask for help yourself, or find a project that needs a hand."
              action={
                <Button href="/projects" variant="outline">
                  Browse projects
                </Button>
              }
            />
          ) : (
            feed.map((t) =>
              t.kind === 'request' ? (
                <TaskCard
                  key={`request-${t.id}`}
                  title={t.title}
                  href={taskHref(t)}
                  status={TaskStatus.not_started}
                  viewer={ONLOOKER}
                  description={t.description}
                  meta={[
                    <span key="asked" className="text-sm">
                      Asked by {t.askedBy?.name ?? 'PauseAI'}
                    </span>,
                    t.global && (
                      <span key="global" className={CHIP}>
                        Every chapter
                      </span>
                    ),
                    hours(t.estimatedHours),
                    due(t.deadline, ONLOOKER),
                  ]}
                >
                  <Button onClick={() => take(t)} disabled={claiming(t.id)}>
                    {claiming(t.id) ? CLAIMING : CLAIM_TASK}
                  </Button>
                </TaskCard>
              ) : t.kind === 'featured' ? (
                <TaskCard
                  key={`featured-${t.id}`}
                  title={t.title}
                  href={taskHref(t)}
                  status={TaskStatus.not_started}
                  viewer={ONLOOKER}
                  description={t.description}
                  meta={[
                    <PartOf key="project" projectId={t.projectId} title={t.projectTitle} />,
                    hours(t.estimatedHours),
                    due(t.deadline, ONLOOKER),
                  ]}
                >
                  <Button onClick={() => take(t)} disabled={claiming(t.id)}>
                    {claiming(t.id) ? CLAIMING : claimLabel(t.claimViewer)}
                  </Button>
                </TaskCard>
              ) : (
                <TaskCard
                  key={`helper-place-${t.id}`}
                  title={t.title}
                  href={taskHref(t)}
                  status={t.status}
                  viewer={ONLOOKER}
                  description={t.description}
                  meta={[
                    <PartOf key="project" projectId={t.projectId} title={t.projectTitle} />,
                    <span key="asking" className="text-sm">
                      {askingFor(t.askedBy, t.placesLeft)}
                    </span>,
                    offeredSummary(t.offeredBy) && (
                      <span key="offered" className="text-text-light text-sm">
                        {offeredSummary(t.offeredBy)}
                      </span>
                    ),
                    due(t.deadline, ONLOOKER),
                  ]}
                >
                  <Button
                    variant="secondary"
                    onClick={() =>
                      offer.mutate({
                        projectId: t.projectId,
                        taskId: t.id,
                        interestType: 'want_to_help_task',
                      })
                    }
                    disabled={offer.isPending && offer.variables?.taskId === t.id}
                  >
                    {joinAsHelperLabel(t.claimViewer)}
                  </Button>
                </TaskCard>
              ),
            )
          )}
        </section>
      )}

      {tab === 'mine' && (
        <>
          {myRequests.length > 0 && <MyRequests requests={myRequests} due={due} />}
          <HeldTasks held={held} onBrowse={() => setChosenTab('open')} />
        </>
      )}
    </main>
  )
}

function MyRequests({
  requests,
  due,
}: {
  requests: MyRequest[]
  due: (deadline: Date | null, viewer: WorkViewer, done?: boolean) => React.ReactNode
}) {
  return (
    <section aria-labelledby="my-requests" className="mb-8">
      <H2 id="my-requests" className="mt-0">
        Your requests for help
      </H2>
      {requests.map((r) => (
        <TaskCard
          key={r.id}
          title={r.title}
          href={taskHref(r)}
          status={r.status}
          viewer={ASKER}
          description={r.description}
          meta={[
            <span key="taken" className="text-text-light text-sm">
              {r.takenBy ? `Taken by ${r.takenBy.name}` : 'Nobody has taken it yet'}
            </span>,
            r.global && (
              <span key="global" className={CHIP}>
                Every chapter
              </span>
            ),
            due(r.deadline, ASKER, handedIn(r.status)),
          ]}
        />
      ))}
    </section>
  )
}

function HeldTasks({ held, onBrowse }: { held: HeldTask[]; onBrowse: () => void }) {
  return (
    <section aria-labelledby="held-tasks">
      <H2 id="held-tasks" className="mt-0">
        You&apos;re doing
      </H2>
      {held.length === 0 ? (
        <EmptyState
          title="Nothing taken yet"
          body="Take something from the Open tab, or browse projects for other ways to contribute."
          action={
            <Button variant="outline" onClick={onBrowse}>
              See open tasks
            </Button>
          }
        />
      ) : (
        held.map((t) => (
          <TaskCard
            key={t.id}
            title={t.title}
            href={taskHref(t)}
            status={t.displayStatus}
            viewer={DOER}
            meta={[
              <span key="role" className="text-text-light text-sm">
                {t.role} · {t.projectTitle}
              </span>,
            ]}
          />
        ))
      )}
    </section>
  )
}
