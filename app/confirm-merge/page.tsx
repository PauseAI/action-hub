'use client'

import { Suspense } from 'react'
import { useSearchParams } from 'next/navigation'
import { useMutation } from '@tanstack/react-query'
import { orpc } from '@/lib/orpc'
import Button from '@/components/Button'
import { H1 } from '@/components/Heading'
import { P } from '@/components/Text'
import { SECTION_CARD } from '@/lib/ui-classes'

const CARD = `${SECTION_CARD} text-center`

/**
 * Where a link sent by a staff merge (lib/staff-merge.ts) lands. It asks before confirming, so a
 * mail scanner that follows the link confirms nothing.
 */
function ConfirmMergeContent() {
  const token = useSearchParams().get('token') ?? ''
  const confirm = useMutation(orpc.accountMerges.confirmStaff.mutationOptions())

  if (confirm.isSuccess) {
    return (
      <div className={CARD}>
        <H1>{confirm.data.merged ? 'Accounts merged' : 'One down, one to go'}</H1>
        <P className="text-text-light mt-4 mb-6">{confirm.data.message}</P>
        {confirm.data.merged && <Button href="/login">Sign in</Button>}
      </div>
    )
  }
  return (
    <div className={CARD}>
      <H1>Are these both your accounts?</H1>
      <P className="text-text-light mt-4">
        Someone who helps run Action Hub thinks this account and another are both yours. If they
        are, confirm here and with the link sent to your other address, and they become one.
      </P>
      {(!token || confirm.isError) && (
        <P role="alert" className="text-error mt-4">
          {confirm.error instanceof Error ? confirm.error.message : 'The link is missing its code'}
        </P>
      )}
      <Button
        className="mt-6"
        disabled={!token || confirm.isPending}
        onClick={() => confirm.mutate({ token })}
      >
        Yes, they are both mine
      </Button>
    </div>
  )
}

export default function ConfirmMergePage() {
  return (
    <main className="container py-5 pb-15">
      <div className="max-w-lg mx-auto">
        <Suspense fallback={null}>
          <ConfirmMergeContent />
        </Suspense>
      </div>
    </main>
  )
}
