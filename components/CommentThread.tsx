'use client'

import { useRef } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import CommentThreadView, { succeeded } from './CommentThreadView'
import { orpc } from '@/lib/orpc'
import { useToast } from '@/lib/toast'
import Button from './Button'
import Tooltip from './Tooltip'
import { P } from './Text'

interface CommentThreadProps {
  workItemId: number
  emptyText?: string
  placeholder?: string
  /** Offers Start a call to whoever may post: for a project's or task's thread. */
  calls?: boolean
}

const CALL_TIP =
  'Opens a video call on meet.jit.si and posts its link here. Whoever starts a call is asked to ' +
  'sign in there (Google, GitHub or Facebook); everyone else joins without an account.'

export default function CommentThread({
  workItemId,
  emptyText,
  placeholder,
  calls = false,
}: CommentThreadProps) {
  const queryClient = useQueryClient()
  const showToast = useToast()

  const { data, isPending } = useQuery({
    ...orpc.workItemComments.list.queryOptions({ input: { workItemId } }),
  })

  const handlers = (done: string, failed: string) => ({
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: orpc.workItemComments.list.key() })
      showToast(done, 'success')
    },
    onError: (err: unknown) => showToast(err instanceof Error ? err.message : failed, 'error'),
  })
  const addMutation = useMutation({
    ...orpc.workItemComments.add.mutationOptions(),
    ...handlers('Comment added', 'Failed to add comment'),
  })
  const editMutation = useMutation({
    ...orpc.workItemComments.edit.mutationOptions(),
    ...handlers('Comment updated', 'Failed to update comment'),
  })
  // The tab is opened on the click itself, so a popup blocker lets it through, then filled in
  // here: these run even if the thread has gone from the page by the time the call is made.
  const callTab = useRef<Window | null>(null)
  const calling = useRef(false)
  const callHandlers = handlers('Call started', 'Failed to start the call')
  const callMutation = useMutation({
    ...orpc.workItemComments.startCall.mutationOptions(),
    onSuccess: ({ callUrl }) => {
      if (callTab.current) {
        callTab.current.opener = null
        callTab.current.location.href = callUrl
      }
      callHandlers.onSuccess()
    },
    onError: (err: unknown) => {
      callTab.current?.close()
      callHandlers.onError(err)
    },
    onSettled: () => {
      callTab.current = null
      calling.current = false
    },
  })
  function startCall() {
    if (calling.current) return
    calling.current = true
    callTab.current = window.open('', '_blank')
    callMutation.mutate({ workItemId })
  }
  const deleteMutation = useMutation({
    ...orpc.workItemComments.delete.mutationOptions(),
    ...handlers('Comment deleted', 'Failed to delete comment'),
  })

  const thread = (
    <CommentThreadView
      comments={data?.feed ?? []}
      canPost={data?.canPost ?? false}
      canReply
      mentionable={data?.mentionable}
      isPending={isPending}
      isSubmitting={addMutation.isPending}
      onSubmit={(content, parentId) =>
        succeeded(() => addMutation.mutateAsync({ workItemId, content, parentId }))
      }
      onEdit={(id, content) => succeeded(() => editMutation.mutateAsync({ id, content }))}
      onDelete={(id) => succeeded(() => deleteMutation.mutateAsync({ id }))}
      emptyText={emptyText}
      placeholder={placeholder}
    />
  )
  if (!calls || !data?.canPost) return thread
  return (
    <>
      <div className="flex justify-end mb-2">
        <Tooltip content={CALL_TIP}>
          <Button
            variant="secondary"
            size="sm"
            disabled={callMutation.isPending}
            onClick={startCall}
            aria-describedby={`call-tip-${workItemId}`}
          >
            {callMutation.isPending ? 'Starting…' : 'Start a call'}
          </Button>
        </Tooltip>
      </div>
      {/* No hover on a phone, so the tooltip's note is spelled out there. */}
      <P id={`call-tip-${workItemId}`} className="text-xs text-text-light -mt-1 mb-3 sm:sr-only">
        {CALL_TIP}
      </P>
      {thread}
    </>
  )
}
