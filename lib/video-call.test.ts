import { describe, it, expect } from 'vitest'
import { VIDEO_CALL_BASE, isCallUrl, newCallUrl } from './video-call'

describe('newCallUrl', () => {
  it('names a room on the call service after the title, with 20 random characters', () => {
    const url = newCallUrl('  Café flyers: Leeds & York!  ')
    expect(url).toMatch(/^https:\/\/meet\.jit\.si\/PauseAI-Cafe-flyers-Leeds-York-[A-Za-z0-9]{20}$/)
    expect(newCallUrl('Café flyers: Leeds & York!')).not.toBe(url)
  })

  it('keeps the readable part short, and leaves it out when the title has none', () => {
    const long = newCallUrl('A very long project title that goes on and on')
    expect(long).toMatch(
      /^https:\/\/meet\.jit\.si\/PauseAI-A-very-long-project-title-that-[A-Za-z0-9]{20}$/,
    )
    expect(newCallUrl('…!?')).toMatch(/^https:\/\/meet\.jit\.si\/PauseAI-[A-Za-z0-9]{20}$/)
  })
})

describe('isCallUrl', () => {
  it('knows a room on the call service from anything else', () => {
    expect(isCallUrl(`${VIDEO_CALL_BASE}/PauseAI-x-abc`)).toBe(true)
    expect(isCallUrl('https://meet.jit.si.evil.example/room')).toBe(false)
    expect(isCallUrl('javascript:alert(1)')).toBe(false)
    expect(isCallUrl(null)).toBe(false)
  })
})
