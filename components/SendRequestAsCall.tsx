'use client'

import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import Button from '@/components/Button'
import FormLabel from '@/components/FormLabel'
import Modal from '@/components/ui/Modal'
import Input from '@/components/ui/Input'
import Textarea from '@/components/ui/Textarea'
import SkillMultiSelect from '@/components/SkillMultiSelect'
import { P } from '@/components/Text'
import { orpc } from '@/lib/orpc'
import { useToast } from '@/lib/toast'

/**
 * For a coordinator on a request for help: puts it out as a call to volunteers with chosen
 * skills, who answer by taking it. A chapter's request goes to that chapter; one in Global
 * requests to the chapters picked, or everyone.
 */
export default function SendRequestAsCall({
  request,
}: {
  request: { id: number; title: string; description: string | null; chapterId: number | null }
}) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>
        Send as a call
      </Button>
      {open && <SendDialog request={request} onClose={() => setOpen(false)} />}
    </>
  )
}

function SendDialog({
  request,
  onClose,
}: {
  request: { id: number; title: string; description: string | null; chapterId: number | null }
  onClose: () => void
}) {
  const showToast = useToast()
  const queryClient = useQueryClient()
  // Cut to what a call holds; a request's own text has no limit.
  const [title, setTitle] = useState(request.title.slice(0, 200))
  const [body, setBody] = useState((request.description ?? request.title).slice(0, 2000))
  const [chapterIds, setChapterIds] = useState<number[]>(
    request.chapterId === null ? [] : [request.chapterId],
  )
  const [skillIds, setSkillIds] = useState<number[]>([])
  const { data: chapters = [] } = useQuery(orpc.chapters.list.queryOptions())
  const own = chapters.find((c) => c.id === request.chapterId)
  const send = useMutation({
    ...orpc.calls.send.mutationOptions(),
    onSuccess: () => {
      showToast('Your call is on its way to volunteers', 'success')
      void queryClient.invalidateQueries({ queryKey: orpc.calls.key() })
      onClose()
    },
    onError: (err) =>
      showToast(err instanceof Error ? err.message : 'Could not send the call', 'error'),
  })
  const toggle = (id: number, on: boolean) =>
    setChapterIds((ids) => (on ? [...ids, id] : ids.filter((x) => x !== id)))

  return (
    <Modal id="send-request-call" title="Send as a call" isOpen onClose={onClose} size="wide">
      <form
        onSubmit={(e) => {
          e.preventDefault()
          send.mutate({ title, body, chapterIds, skillIds, requestId: request.id })
        }}
      >
        <FormLabel htmlFor="request-call-title">Title</FormLabel>
        <Input
          id="request-call-title"
          value={title}
          maxLength={200}
          onChange={(e) => setTitle(e.target.value)}
        />
        <FormLabel htmlFor="request-call-body" className="mt-3">
          What you are asking for
        </FormLabel>
        <Textarea
          id="request-call-body"
          rows={4}
          value={body}
          maxLength={2000}
          onChange={(e) => setBody(e.target.value)}
        />
        {request.chapterId === null ? (
          <fieldset className="mt-3">
            <legend className="font-semibold">Chapters</legend>
            <P className="text-text-light text-sm m-0">
              Leave all unticked to ask every chapter and the holding pool.
            </P>
            <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2">
              {chapters.map((c) => (
                <FormLabel key={c.id} className="flex items-center gap-2 font-normal">
                  <input
                    type="checkbox"
                    checked={chapterIds.includes(c.id)}
                    onChange={(e) => toggle(c.id, e.target.checked)}
                  />
                  {c.name}
                </FormLabel>
              ))}
            </div>
          </fieldset>
        ) : (
          <P className="text-sm mt-3">Goes to {own?.name ?? 'its chapter'}, where it was asked.</P>
        )}
        <div className="mt-3">
          <SkillMultiSelect
            id="request-call-skills"
            label="Skills it asks for"
            value={skillIds}
            onChange={setSkillIds}
          />
        </div>
        <P className="text-text-light text-sm mt-3">
          Volunteers answer by taking the request, or helping on it once someone has. You see who
          answered on your Coordinate page.
        </P>
        <div className="flex gap-3 justify-end">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={!title.trim() || !body.trim() || send.isPending}>
            Send call
          </Button>
        </div>
      </form>
    </Modal>
  )
}
