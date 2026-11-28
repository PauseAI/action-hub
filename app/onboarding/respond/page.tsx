'use client'

import { Suspense } from 'react'
import { useSearchParams } from 'next/navigation'
import { useMutation, useQuery } from '@tanstack/react-query'
import { orpc } from '@/lib/orpc'
import { formatCallTime } from '@/lib/onboarding'
import Button from '@/components/Button'
import { H1 } from '@/components/Heading'
import { P } from '@/components/Text'
import { SECTION_CARD } from '@/lib/ui-classes'

const CARD = `${SECTION_CARD} text-center`

/**
 * Where a host's reminder links land, signed in or not. It asks before answering, so a mail
 * scanner that follows the link answers nothing.
 */
function RespondContent() {
  const params = useSearchParams()
  const token = params.get('token') ?? ''
  const answer = params.get('answer') === 'cover' ? 'cover' : 'on'
  const call = useQuery({
    ...orpc.onboarding.byToken.queryOptions({ input: { token } }),
    enabled: Boolean(token),
    retry: false,
  })
  const respond = useMutation(orpc.onboarding.respond.mutationOptions())

  if (respond.isSuccess) {
    return (
      <div className={CARD}>
        <H1>Thank you</H1>
        <P className="text-text-light mt-4">{respond.data.message}</P>
      </div>
    )
  }
  if (!token || call.isError) {
    return (
      <div className={CARD}>
        <H1>This link doesn&apos;t work</H1>
        <P role="alert" className="text-error mt-4">
          {call.error instanceof Error ? call.error.message : 'The link is missing its code'}
        </P>
        <Button className="mt-6" href="/onboarding">
          Open Global Onboarding
        </Button>
      </div>
    )
  }
  if (!call.data) return null
  const when = formatCallTime(new Date(call.data.startsAt))
  const other = answer === 'on' ? 'cover' : 'on'
  const label = { on: "I'm on", cover: 'I need cover' }
  return (
    <div className={CARD}>
      <H1>{`${call.data.name}, ${when}`}</H1>
      <P className="text-text-light mt-4">
        {call.data.hostName}, you&apos;re hosting this welcome call.
        {call.data.confirmed && " You've already said you're on."}
        {call.data.coverRequested && " You've asked for cover."}
      </P>
      {respond.isError && (
        <P role="alert" className="text-error mt-4">
          {respond.error instanceof Error ? respond.error.message : 'Something went wrong'}
        </P>
      )}
      <div className="flex flex-wrap justify-center gap-3 mt-6">
        <Button disabled={respond.isPending} onClick={() => respond.mutate({ token, answer })}>
          {label[answer]}
        </Button>
        <Button
          variant="outline"
          disabled={respond.isPending}
          onClick={() => respond.mutate({ token, answer: other })}
        >
          {label[other]}
        </Button>
      </div>
    </div>
  )
}

export default function RespondPage() {
  return (
    <main className="container py-5 pb-15">
      <div className="max-w-lg mx-auto">
        <Suspense fallback={null}>
          <RespondContent />
        </Suspense>
      </div>
    </main>
  )
}
