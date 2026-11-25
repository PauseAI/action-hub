import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import NewTaskForm from './NewTaskForm'

describe('NewTaskForm as an outline item', () => {
  it('sends the title alone, even with details typed before it became one', async () => {
    const onCreate = vi.fn(async () => true)
    const props = { onCreate, pending: false, submitLabel: 'Add', pendingLabel: 'Adding…' }
    const { rerender } = render(<NewTaskForm {...props} />)
    await userEvent.type(screen.getByLabelText('Task title'), 'Find a venue')
    await userEvent.click(screen.getByRole('button', { name: 'More details' }))
    await userEvent.type(screen.getByLabelText('Details (optional)'), 'hidden')
    await userEvent.type(screen.getByLabelText('Helpers wanted (optional)'), '3')
    rerender(<NewTaskForm {...props} outline />)
    expect(screen.queryByLabelText('Helpers wanted (optional)')).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'Add' }))
    expect(onCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Find a venue',
        description: undefined,
        helpersWanted: null,
        featuredAsQuickTask: false,
        submissionPrompt: null,
        startDate: null,
        deadline: null,
      }),
    )
  })
})
