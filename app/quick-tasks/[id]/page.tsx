'use client'

import { use, useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useRouter } from 'next/navigation'
import { useRequireApproved } from '@/lib/hooks/auth'
import { orpc } from '@/lib/orpc'
import Button from '@/components/Button'
import { P } from '@/components/Text'
import PageLoading from '@/components/PageLoading'

/** A /quick-tasks/:id link, from an old email or notification, opens the request it became. */
export default function QuickTaskLinkPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: idStr } = use(params)
  const id = parseInt(idStr, 10)
  const { user, loading } = useRequireApproved()
  const router = useRouter()
  const { data: found, isPending } = useQuery({
    ...orpc.requests.locate.queryOptions({ input: { id } }),
    enabled: !!user && !isNaN(id),
  })
  useEffect(() => {
    if (found) router.replace(`/projects/${found.projectId}/tasks/${found.taskId}`)
  }, [found, router])

  if (loading || !user || found || (!isNaN(id) && isPending)) return <PageLoading />
  return (
    <main className="container py-5">
      <P className="text-text-light">Task not found.</P>
      <Button href="/tasks" variant="outline" size="sm">
        See open tasks
      </Button>
    </main>
  )
}
