import { describe, expect, it } from 'vitest'
import { askingFor, helperSummary, leadAndHelpers, offeredSummary } from './helper-summary'

describe('helperSummary', () => {
  it('says how many help and how many more are wanted', () => {
    expect(helperSummary(0, null)).toBeNull()
    expect(helperSummary(0, 2)).toBe('2 helpers wanted')
    expect(helperSummary(0, 1)).toBe('1 helper wanted')
    expect(helperSummary(3, 5)).toBe('3 helpers (2 more wanted)')
    expect(helperSummary(1, 1)).toBe('1 helper')
    // Fewer wanted than are helping, after the number was lowered: no "more wanted".
    expect(helperSummary(3, 2)).toBe('3 helpers')
    expect(helperSummary(2, null)).toBe('2 helpers')
  })
})

describe('leadAndHelpers', () => {
  it('names the lead beside the helpers, or alone when there are none', () => {
    expect(leadAndHelpers('Sam', 3, 5)).toBe('Lead: Sam · 3 helpers (2 more wanted)')
    expect(leadAndHelpers('Sam', 0, null)).toBe('Sam')
  })

  it('says who is asking for how many helpers, and who has offered', () => {
    expect(askingFor({ name: 'Lee' }, 1)).toBe('Lee is asking for 1 helper')
    expect(askingFor(null, 2)).toBe('2 helpers wanted')
    expect(offeredSummary([])).toBeNull()
    expect(offeredSummary([{ name: 'Sam' }])).toBe('Sam has offered')
    expect(offeredSummary([{ name: 'Sam' }, { name: 'Kim' }])).toBe('Sam and Kim have offered')
    expect(offeredSummary([{ name: 'A' }, { name: 'B' }, { name: 'C' }])).toBe(
      '3 people have offered',
    )
  })
})
