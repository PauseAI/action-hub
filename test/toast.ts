import { expect } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

/**
 * Waits for the toast saying `text`, dismisses it and waits for it to go, so a later step that
 * shows the same words waits for a toast of its own, not one about to dismiss itself.
 */
export async function dismissToast(text: string | RegExp): Promise<void> {
  const toast = (await screen.findByText(text)).closest<HTMLElement>('[role=alert]')
  if (!toast) throw new Error(`${String(text)} is not in a toast`)
  await userEvent.click(within(toast).getByRole('button', { name: 'Dismiss' }))
  await waitFor(() => expect(toast).not.toBeInTheDocument())
}
