'use client'

import { useRef, useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { orpc } from '@/lib/orpc'
import { useToast } from '@/lib/toast'
import { SECTION_CARD } from '@/lib/ui-classes'
import Button from '@/components/Button'
import FormLabel from '@/components/FormLabel'
import { H2 } from '@/components/Heading'
import { P } from '@/components/Text'
import Input from '@/components/ui/Input'
import Textarea from '@/components/ui/Textarea'

/** Someone already on Action Hub, and the address that found them. */
type Existing = { name: string; chapterName: string | null; email: string }

/**
 * A chapter's staff invite someone to join it by email. Someone with no account is sent a link
 * to sign up; someone already in another chapter is named, with the offer to ask their chapter
 * to let them come (`chapterTransfers.inviteToChapter`).
 */
export default function ChapterMemberInvite({
  chapterId,
  chapterName,
}: {
  chapterId: number
  chapterName: string
}) {
  const showToast = useToast()
  const [email, setEmail] = useState('')
  // What the field holds now, for a reply to check it still answers it.
  const field = useRef('')
  const [reason, setReason] = useState('')
  const [existing, setExisting] = useState<Existing | null>(null)
  const invite = useMutation({
    ...orpc.chapterTransfers.inviteToChapter.mutationOptions(),
    onSuccess: (r, sent) => {
      showToast(r.message, 'success')
      if (r.existing && !sent.bring) {
        // A reply for an address the field no longer holds is stale: no offer for it.
        if (sent.email === field.current.trim()) setExisting({ ...r.existing, email: sent.email })
        return
      }
      field.current = ''
      setEmail('')
      setReason('')
      setExisting(null)
    },
    onError: (err: unknown) =>
      showToast(err instanceof Error ? err.message : 'Failed to send the invite', 'error'),
  })
  const where = existing?.chapterName ? `the ${existing.chapterName} chapter` : 'the holding pool'
  return (
    <section aria-labelledby="member-invite" className={`card ${SECTION_CARD} mb-5`}>
      <H2 id="member-invite" className="mt-0">
        Invite someone to join
      </H2>
      <P className="text-text-light text-sm">
        Someone new gets a link to sign up with {chapterName} filled in. If they are already on
        Action Hub, you are told where, and can ask their chapter to let them come.
      </P>
      <form
        className="flex gap-3 items-end flex-wrap"
        onSubmit={(e) => {
          e.preventDefault()
          setExisting(null)
          invite.mutate({ chapterId, email: email.trim() })
        }}
      >
        <div>
          <FormLabel htmlFor="member-invite-email">Their email</FormLabel>
          <Input
            id="member-invite-email"
            type="email"
            value={email}
            onChange={(e) => {
              field.current = e.target.value
              setEmail(e.target.value)
              setExisting(null)
            }}
            required
          />
        </div>
        <Button type="submit" disabled={invite.isPending}>
          Invite to join
        </Button>
      </form>
      {existing && (
        <div role="status" className="mt-4">
          <P className="m-0 mb-2">
            {existing.name} is already on Action Hub, in {where}.
          </P>
          <FormLabel htmlFor="member-invite-reason">Why (optional)</FormLabel>
          <Textarea
            id="member-invite-reason"
            rows={2}
            maxLength={1000}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
          <Button
            className="mt-2"
            size="sm"
            disabled={invite.isPending}
            onClick={() =>
              invite.mutate({
                chapterId,
                email: existing.email,
                bring: true,
                reason: reason.trim() || null,
              })
            }
          >
            Ask to bring {existing.name} into {chapterName}
          </Button>
        </div>
      )}
    </section>
  )
}
