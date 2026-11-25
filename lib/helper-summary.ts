import { plural } from './plural'

/**
 * A task's helpers in a few words: "3 helpers (2 more wanted)", "2 helpers wanted", "1 helper".
 * Null when it has none and seeks none. Kept free of server imports so client components can use
 * it.
 */
export function helperSummary(count: number, wanted: number | null): string | null {
  const more = wanted === null ? 0 : Math.max(0, wanted - count)
  if (count === 0) return more > 0 ? `${plural(more, 'helper')} wanted` : null
  return more > 0 ? `${plural(count, 'helper')} (${more} more wanted)` : plural(count, 'helper')
}

/** "Lead: Sam · 3 helpers (2 more wanted)", or just the lead's name when nobody helps or is sought. */
export function leadAndHelpers(leadName: string, count: number, wanted: number | null): string {
  const helpers = helperSummary(count, wanted)
  return helpers ? `Lead: ${leadName} · ${helpers}` : leadName
}

/** "Lee is asking for 2 helpers", or "2 helpers wanted" when nobody leads the task. */
export function askingFor(askedBy: { name: string } | null, placesLeft: number): string {
  const helpers = plural(placesLeft, 'helper')
  return askedBy ? `${askedBy.name} is asking for ${helpers}` : `${helpers} wanted`
}

/** "Sam has offered", "Sam and Kim have offered", "3 people have offered"; null for nobody. */
export function offeredSummary(people: { name: string }[]): string | null {
  if (people.length === 0) return null
  if (people.length === 1) return `${people[0].name} has offered`
  if (people.length === 2) return `${people[0].name} and ${people[1].name} have offered`
  return `${people.length} people have offered`
}
