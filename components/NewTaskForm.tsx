'use client'

import { useState, type FormEvent } from 'react'
import Button from '@/components/Button'
import Checkbox from '@/components/Checkbox'
import DatesBlock from '@/components/DatesBlock'
import FormLabel from '@/components/FormLabel'
import HelpersWantedField, { helpersWantedPayload } from '@/components/HelpersWantedField'
import SubmissionAskFields, {
  NEW_SUBMISSION_ASK,
  submissionAskPayload,
} from '@/components/SubmissionAskFields'
import Input from '@/components/ui/Input'
import Textarea from '@/components/ui/Textarea'
import { EMPTY_DATES, datesPayload } from '@/lib/task-dates'

/** What a new task is created with: the fields of `projects.createTask` bar the project. */
export type NewTask = {
  title: string
  description: string | undefined
  featuredAsQuickTask: boolean
} & ReturnType<typeof datesPayload> &
  ReturnType<typeof submissionAskPayload> &
  ReturnType<typeof helpersWantedPayload>

/**
 * The one form for adding a task to a project, on the project page and in the project editor:
 * a title row that is enough on its own, and everything else behind "More details".
 */
export default function NewTaskForm({
  onCreate,
  pending,
  submitLabel,
  pendingLabel,
  onCancel,
  datesNote,
  autoFocus,
  allowQuickTask = true,
  outline = false,
  initial,
  className = '',
}: {
  /** Creates the task; resolves true once it exists, which clears the form. */
  onCreate: (task: NewTask) => Promise<boolean>
  pending: boolean
  submitLabel: string
  pendingLabel: string
  onCancel?: () => void
  /** A line under the dates, such as who can change them later. */
  datesNote?: string
  autoFocus?: boolean
  /** Offers featuring it on the Tasks page; off where the project is not yet approved. */
  allowQuickTask?: boolean
  /** An outline item for a proposal: a title only, planned into a task after approval. */
  outline?: boolean
  /** An outline item being planned into a task: its title and note, with the details open. */
  initial?: { title: string; description: string | null }
  className?: string
}) {
  const [title, setTitle] = useState(initial?.title ?? '')
  const [description, setDescription] = useState(initial?.description ?? '')
  const [dates, setDates] = useState(EMPTY_DATES)
  const [ask, setAsk] = useState(NEW_SUBMISSION_ASK)
  const [helpers, setHelpers] = useState('')
  const [featured, setFeatured] = useState(false)
  const [showDetails, setShowDetails] = useState(initial !== undefined)

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    if (pending || !title.trim()) return
    // An outline item is its title alone: details typed before the form became one are not sent.
    const created = await onCreate({
      title: title.trim(),
      description: (!outline && description.trim()) || undefined,
      ...datesPayload(outline ? EMPTY_DATES : dates),
      featuredAsQuickTask: !outline && allowQuickTask && featured,
      ...submissionAskPayload(outline ? NEW_SUBMISSION_ASK : ask),
      ...helpersWantedPayload(outline ? '' : helpers),
    })
    if (!created) return
    setTitle('')
    setDescription('')
    setDates(EMPTY_DATES)
    setAsk(NEW_SUBMISSION_ASK)
    setHelpers('')
    setFeatured(false)
    setShowDetails(false)
  }

  return (
    <form
      onSubmit={handleSubmit}
      className={`bg-brand-bg rounded-lg p-3 border border-brand-border ${className}`}
    >
      <FormLabel htmlFor="new-task-title" className="text-sm" required>
        {outline ? 'Outline item' : 'Task title'}
      </FormLabel>
      <div className="flex flex-wrap gap-2">
        <Input
          id="new-task-title"
          type="text"
          className="flex-1 min-w-48"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder={outline ? 'e.g. Find a venue' : 'e.g. Draft copy for homepage'}
          autoFocus={autoFocus}
        />
        <Button type="submit" variant="secondary" disabled={pending || !title.trim()}>
          {pending ? pendingLabel : submitLabel}
        </Button>
        {onCancel && (
          <Button type="button" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        )}
      </div>
      {/* Once open the details stay open until the task is added, so nothing entered is sent
          unseen and the dates' own validity check stays on the form. */}
      {outline ? null : showDetails ? (
        <div className="mt-3">
          <div className="mb-3">
            <FormLabel htmlFor="new-task-description">Details (optional)</FormLabel>
            <Textarea
              id="new-task-description"
              rows={3}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Add any context, examples, or guidelines…"
            />
          </div>
          <div className="mb-1">
            <DatesBlock id="new-task" value={dates} onChange={setDates} note={datesNote} />
          </div>
          <SubmissionAskFields id="new-task" value={ask} onChange={setAsk} />
          <HelpersWantedField id="new-task" value={helpers} onChange={setHelpers} />
          {allowQuickTask && (
            <Checkbox checked={featured} onChange={(e) => setFeatured(e.target.checked)}>
              Add this task to the Tasks page so volunteers can find and take it without first
              opening this project
            </Checkbox>
          )}
        </div>
      ) : (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="mt-2"
          aria-expanded={false}
          onClick={() => setShowDetails(true)}
        >
          More details
        </Button>
      )}
    </form>
  )
}
