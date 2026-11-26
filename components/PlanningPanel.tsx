'use client'

import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import Button from '@/components/Button'
import { H2 } from '@/components/Heading'
import NewTaskForm, { type NewTask } from '@/components/NewTaskForm'
import type { ProjectTask } from '@/components/ProjectTaskList'
import { P } from '@/components/Text'
import Modal from '@/components/ui/Modal'
import { orpc } from '@/lib/orpc'
import { plural } from '@/lib/plural'
import { useToast } from '@/lib/toast'

const banner =
  'rounded-lg border p-4 mb-4 bg-blue-100 text-blue-900 border-blue-300 dark:bg-blue-950 dark:text-blue-200 dark:border-blue-600'

/**
 * A project in Planning: what is left before its owner finishes planning, and the button that
 * does it. Everyone else is told the tasks open up as they are planned.
 */
export function PlanningBanner({
  projectId,
  title,
  hasOwner,
  plannedTasks,
  outlineItems,
  totalHours,
  taskHours,
  canFinish,
  canPlan,
  editHref,
  onChanged,
}: {
  projectId: number
  title: string
  hasOwner: boolean
  plannedTasks: number
  outlineItems: number
  totalHours: number | null
  taskHours: number
  canFinish: boolean
  /** A deputy plans outline items but leaves finishing to the owner. */
  canPlan: boolean
  editHref: string
  onChanged: () => void
}) {
  const toast = useToast()
  const finish = useMutation({
    ...orpc.projects.finishPlanning.mutationOptions(),
    onSuccess: () => {
      toast('Planning finished', 'success')
      onChanged()
    },
    onError: (err: unknown) =>
      toast(err instanceof Error ? err.message : 'Could not finish planning', 'error'),
  })

  if (!canFinish) {
    return (
      <section aria-label="Planning" className={banner}>
        <P className="m-0">
          <strong>{title}</strong> is being planned.{' '}
          {canPlan
            ? 'Plan its outline items into tasks; the owner finishes planning.'
            : 'Its tasks open up as the owner plans them.'}
        </P>
      </section>
    )
  }

  const ready = hasOwner && plannedTasks > 0
  return (
    <section aria-label="Planning" className={banner}>
      <H2 className="mt-0 mb-2 text-lg">Planning</H2>
      <P className="mt-0 mb-2">
        Turn the outline into tasks people can pick up: give each its dates, effort, helpers and
        what to submit. Finish planning when there is enough to start on.
      </P>
      <ul className="mt-0 mb-3 pl-5 list-disc">
        <li>{hasOwner ? 'The project has an owner' : 'It needs an owner first'}</li>
        <li>
          {plannedTasks > 0
            ? `${plural(plannedTasks, 'task')} planned`
            : 'No tasks planned yet: plan at least one'}
        </li>
        {outlineItems > 0 && (
          <li>{plural(outlineItems, 'outline item')} left, which can wait until later</li>
        )}
        <li>
          {totalHours !== null ? (
            `About ${plural(totalHours, 'hour')} in total${taskHours > 0 ? `; the tasks add up to ${plural(Math.round(taskHours * 10) / 10, 'hour')}` : ''}`
          ) : (
            <>
              No total hours yet: <a href={editHref}>add an estimate</a>
            </>
          )}
        </li>
      </ul>
      <Button
        type="button"
        disabled={!ready || finish.isPending}
        onClick={() => finish.mutate({ id: projectId })}
      >
        {finish.isPending ? 'Finishing…' : 'Finish planning'}
      </Button>
    </section>
  )
}

/**
 * The rough outline a proposal brought: titles waiting to be planned into tasks. Whoever runs
 * the tasks plans each one with the same form that adds a task.
 */
export function OutlineList({
  projectId,
  outline,
  canPlan,
  onChanged,
}: {
  projectId: number
  outline: ProjectTask[]
  canPlan: boolean
  onChanged: () => void
}) {
  const toast = useToast()
  const [planning, setPlanning] = useState<ProjectTask | null>(null)
  const plan = useMutation({
    ...orpc.projects.updateTask.mutationOptions(),
    onSuccess: () => {
      toast('Planned as a task', 'success')
      setPlanning(null)
      onChanged()
    },
    onError: (err: unknown) =>
      toast(err instanceof Error ? err.message : 'Could not plan this task', 'error'),
  })

  async function handlePlan(item: ProjectTask, task: NewTask): Promise<boolean> {
    try {
      await plan.mutateAsync({
        projectId,
        taskId: item.id,
        // A note emptied in the form is cleared, not kept from the outline item.
        data: { ...task, description: task.description ?? null, isOutline: false },
      })
      return true
    } catch {
      return false
    }
  }

  return (
    <section aria-label="Outline" className="mb-4">
      <H2 className="mt-0 mb-1 text-lg">Outline</H2>
      <P className="mt-0 mb-2 text-sm text-text-light">
        Rough steps from the proposal, not yet tasks anyone can take.
      </P>
      <ul className="m-0 p-0 list-none flex flex-col gap-2">
        {outline.map((item) => (
          <li
            key={item.id}
            className="flex flex-wrap items-center gap-2 rounded-lg border border-dashed border-brand-border px-3 py-2"
          >
            <div className="min-w-0 flex-1">
              <span className="font-medium">{item.title}</span>
              {item.description && (
                <P className="m-0 text-sm text-text-light">{item.description}</P>
              )}
            </div>
            {canPlan && (
              <Button variant="secondary" size="sm" onClick={() => setPlanning(item)}>
                Plan as task
              </Button>
            )}
          </li>
        ))}
      </ul>
      {planning && (
        <Modal
          id="plan-outline-item"
          title="Plan as a task"
          size="wide"
          isOpen
          onClose={() => setPlanning(null)}
        >
          <NewTaskForm
            initial={{ title: planning.title, description: planning.description }}
            onCreate={(task) => handlePlan(planning, task)}
            pending={plan.isPending}
            submitLabel="Make it a task"
            pendingLabel="Saving…"
            onCancel={() => setPlanning(null)}
            autoFocus
          />
        </Modal>
      )}
    </section>
  )
}
