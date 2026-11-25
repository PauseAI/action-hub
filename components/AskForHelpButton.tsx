'use client'

import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useRouter } from 'next/navigation'
import Button from '@/components/Button'
import Checkbox from '@/components/Checkbox'
import FormLabel from '@/components/FormLabel'
import Input from '@/components/ui/Input'
import Modal from '@/components/ui/Modal'
import Textarea from '@/components/ui/Textarea'
import { P } from '@/components/Text'
import { fromDateInputValue } from '@/lib/format-date'
import { orpc } from '@/lib/orpc'
import { useToast } from '@/lib/toast'

/**
 * '+ Ask for help': posts a request to the asker's chapter (or everyone, when they choose, or
 * when they have no chapter), then opens it.
 */
export default function AskForHelpButton({ chapterName }: { chapterName: string | null }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button onClick={() => setOpen(true)}>+ Ask for help</Button>
      {open && <AskForHelpDialog chapterName={chapterName} onClose={() => setOpen(false)} />}
    </>
  )
}

function AskForHelpDialog({
  chapterName,
  onClose,
}: {
  chapterName: string | null
  onClose: () => void
}) {
  const showToast = useToast()
  const router = useRouter()
  const queryClient = useQueryClient()
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [hours, setHours] = useState('')
  const [deadline, setDeadline] = useState('')
  const [helpers, setHelpers] = useState('')
  const [global, setGlobal] = useState(chapterName === null)

  const ask = useMutation({
    ...orpc.requests.ask.mutationOptions(),
    onSuccess: (data) => {
      showToast(data.message, 'success')
      void queryClient.invalidateQueries({ queryKey: orpc.requests.key() })
      void queryClient.invalidateQueries({ queryKey: orpc.quickTasks.available.key() })
      router.push(`/projects/${data.projectId}/tasks/${data.id}`)
    },
    onError: (err: unknown) =>
      showToast(err instanceof Error ? err.message : 'Could not post your request', 'error'),
  })

  function submit(e: React.FormEvent) {
    e.preventDefault()
    ask.mutate({
      title,
      description: description.trim() || null,
      estimatedHours: hours ? Number(hours) : null,
      deadline: deadline ? fromDateInputValue(deadline) : null,
      helpersWanted: helpers ? Number(helpers) : null,
      global,
    })
  }

  return (
    <Modal id="ask-for-help" title="Ask for help" isOpen onClose={onClose} size="wide">
      <P className="text-text-light mt-0">
        Anyone {global ? 'in any chapter' : `in ${chapterName}`} can take it. You review the work
        when they hand it in.
      </P>
      <form onSubmit={submit}>
        <div className="mb-5">
          <FormLabel htmlFor="ask-title">What do you need?</FormLabel>
          <Input
            id="ask-title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            required
            autoFocus
            placeholder="e.g., Proofread our flyer before Friday"
          />
        </div>
        <div className="mb-5">
          <FormLabel htmlFor="ask-description">Details</FormLabel>
          <Textarea
            id="ask-description"
            rows={4}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What should they do, and what would done look like?"
          />
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-5">
          <div>
            <FormLabel htmlFor="ask-hours">Hours, roughly</FormLabel>
            <Input
              id="ask-hours"
              type="number"
              min="0.5"
              step="0.5"
              value={hours}
              onChange={(e) => setHours(e.target.value)}
            />
          </div>
          <div>
            <FormLabel htmlFor="ask-deadline">Needed by</FormLabel>
            <Input
              id="ask-deadline"
              type="date"
              value={deadline}
              onChange={(e) => setDeadline(e.target.value)}
            />
          </div>
          <div>
            <FormLabel htmlFor="ask-helpers">Helpers as well</FormLabel>
            <Input
              id="ask-helpers"
              type="number"
              min="1"
              max="100"
              value={helpers}
              onChange={(e) => setHelpers(e.target.value)}
              placeholder="None"
            />
          </div>
        </div>
        {chapterName !== null && (
          <div className="mb-5">
            <Checkbox checked={global} onChange={(e) => setGlobal(e.target.checked)}>
              Ask people in every chapter, not just {chapterName}
            </Checkbox>
          </div>
        )}
        <div className="flex gap-3 justify-end">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={ask.isPending}>
            {ask.isPending ? 'Posting…' : 'Post request'}
          </Button>
        </div>
      </form>
    </Modal>
  )
}
