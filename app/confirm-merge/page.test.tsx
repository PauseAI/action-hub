import { describe, it, expect } from 'vitest'
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { prisma } from '@/lib/prisma'
import { createAdmin, createVolunteer } from '@/test/factories'
import { renderApp } from '@/test/render'
import { clientAs } from '@/test/rpc'
import ConfirmMergePage from './page'

async function waitingMerge() {
  const kept = await createVolunteer({ name: 'Zed Same' })
  const merged = await createVolunteer({ name: 'Zed Same' })
  await clientAs(await createAdmin()).admin.volunteers.merge({
    keptId: kept.id,
    mergedId: merged.id,
  })
  return prisma.staffMergeRequest.findFirstOrThrow({ where: { keptId: kept.id } })
}

const open = (token?: string) => {
  window.history.replaceState(null, '', token ? `/confirm-merge?token=${token}` : '/confirm-merge')
  return renderApp(<ConfirmMergePage />)
}

describe('confirm merge page', () => {
  it('confirms one address, then the other, which merges them', async () => {
    const request = await waitingMerge()
    await open(request.keptToken as string)
    await userEvent.click(await screen.findByRole('button', { name: 'Yes, they are both mine' }))
    expect(await screen.findByRole('heading', { name: 'One down, one to go' })).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Sign in' })).toBeNull()

    await open(request.mergedToken as string)
    await userEvent.click(
      (await screen.findAllByRole('button', { name: 'Yes, they are both mine' })).at(-1)!,
    )
    expect(await screen.findByRole('heading', { name: 'Accounts merged' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/login')
  })

  it('says when the link is missing its code or no longer works', async () => {
    await open()
    expect(await screen.findByRole('alert')).toHaveTextContent('The link is missing its code')
    expect(screen.getByRole('button', { name: 'Yes, they are both mine' })).toBeDisabled()
  })

  it('reports a link that has been used', async () => {
    await open('not-a-token')
    await userEvent.click(await screen.findByRole('button', { name: 'Yes, they are both mine' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This link has expired or was already used',
    )
  })
})
