'use client'

import { useSyncExternalStore } from 'react'
import { usePathname } from 'next/navigation'
import Button from '@/components/Button'
import { parentPage } from '@/lib/parent-page'

const STANDALONE = '(display-mode: standalone)'

function subscribeStandalone(onChange: () => void) {
  const mq = window.matchMedia(STANDALONE)
  mq.addEventListener('change', onChange)
  return () => mq.removeEventListener('change', onChange)
}

/** Installed and opened from the home screen; iOS Safari reports it on `navigator` instead. */
function isStandalone() {
  return (
    window.matchMedia(STANDALONE).matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  )
}

/** The parts of the Navigation API used here. */
type NavigationApi = EventTarget & {
  currentEntry: { index: number } | null
  entries(): { url: string | null }[]
}

const navigationApi = () => (window as Window & { navigation?: NavigationApi }).navigation

/** Sign-in pages send a signed-in user on, so neither going back to nor from one helps. */
const AUTH_PAGES = new Set(['/login', '/signup'])

function subscribeHistory(onChange: () => void) {
  const nav = navigationApi()
  nav?.addEventListener('currententrychange', onChange)
  return () => nav?.removeEventListener('currententrychange', onChange)
}

/**
 * Whether the page before this one in the session is one of ours worth returning to. Without
 * the Navigation API there is no telling (`history.length` counts pages ahead too), so no.
 */
function canGoBack() {
  const nav = navigationApi()
  const index = nav?.currentEntry?.index ?? 0
  if (!nav || index === 0) return false
  const url = nav.entries()[index - 1]?.url
  return !!url && !AUTH_PAGES.has(new URL(url).pathname)
}

const never = () => false

/**
 * An installed app has no browser chrome, so no back button of its own. Goes back through
 * the session's history, or, with nothing worth going back to, up to the page's parent.
 */
export default function BackButton() {
  const pathname = usePathname()
  const standalone = useSyncExternalStore(subscribeStandalone, isStandalone, never)
  const hasHistory = useSyncExternalStore(subscribeHistory, canGoBack, never)

  if (!standalone || AUTH_PAGES.has(pathname)) return null
  const parent = hasHistory ? null : parentPage(pathname)
  if (!hasHistory && !parent) return null

  const props = {
    variant: 'ghost',
    size: 'md',
    icon: true,
    className: 'border border-brand-border shrink-0',
    'aria-label': 'Back',
    children: (
      <svg
        width="22"
        height="22"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <polyline points="15 18 9 12 15 6" />
      </svg>
    ),
  } as const

  return parent ? (
    // Replacing the entry keeps the parent first in the session, so its own Back goes up again.
    <Button href={parent} replace {...props} />
  ) : (
    <Button onClick={() => window.history.back()} {...props} />
  )
}
