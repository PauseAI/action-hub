/** Where calls are held. Moving to JaaS or a self-hosted Jitsi is a change to this line. */
export const VIDEO_CALL_BASE = 'https://meet.jit.si'

const ROOM_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'

/** `length` characters from ROOM_CHARS, each equally likely: bytes from 248 (4 × 62) are dropped. */
function randomRoomPart(length: number): string {
  let out = ''
  while (out.length < length) {
    for (const byte of crypto.getRandomValues(new Uint8Array(length))) {
      if (byte < 248 && out.length < length) out += ROOM_CHARS[byte % 62]
    }
  }
  return out
}

/**
 * A new call room for `title`: readable enough to recognise, and with 20 random characters so
 * nobody outside the thread can guess it.
 */
export function newCallUrl(title: string): string {
  const slug = title
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 30)
    .replace(/-+$/, '')
  const room = ['PauseAI', slug, randomRoomPart(20)].filter(Boolean).join('-')
  return `${VIDEO_CALL_BASE}/${room}`
}

/** Whether `url` is a room on the call service, so a stored link is shown as a call. */
export function isCallUrl(url: string | null | undefined): url is string {
  return Boolean(url?.startsWith(`${VIDEO_CALL_BASE}/`))
}
