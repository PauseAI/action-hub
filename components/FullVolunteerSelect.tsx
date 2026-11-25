'use client'

import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import FilterDropdown, { FilterOption } from '@/components/FilterDropdown'
import { orpc } from '@/lib/orpc'

const DEBOUNCE_MS = 300
const RESULT_LIMIT = 20

interface Props {
  id: string
  label: string
  ariaLabel: string
  value: string
  onChange: (value: string) => void
  placeholder?: string
  required?: boolean
  hideLabel?: boolean
  triggerClassName?: string
  enabled?: boolean
  /**
   * People listed first under their own headings, such as a project's owner, deputies, members
   * and applicants, whoever the search finds. Someone in two groups shows in the first.
   */
  pinned?: PinnedGroup[]
  /** People never offered, such as whoever already holds the task. */
  exclude?: number[]
  /**
   * The chapter to search, for someone whose directory spans chapters; everyone else's search is
   * held to their own. A project's pickers pass `pickerChapter` (lib/chapter-access.ts).
   */
  chapter?: number | 'pool'
}

export type PinnedGroup = { title: string; people: { id: number; name: string }[] }

// Typeahead over a server-side search (name/bio) of the whole volunteer base, rather than
// LocalVolunteerSelect's filter over a list the caller already has — for picking one volunteer
// out of however many there are. Each option shows name plus location context (local group or
// country) so admins can make location-aware assignments, and to a global admin the email and
// any duplicate mark too.
export default function FullVolunteerSelect({
  id,
  label,
  ariaLabel,
  value,
  onChange,
  placeholder = '— Select volunteer —',
  required,
  hideLabel,
  triggerClassName,
  enabled = true,
  pinned = [],
  exclude = [],
  chapter,
}: Props) {
  const [searchInput, setSearchInput] = useState('')
  const [search, setSearch] = useState('')
  useEffect(() => {
    const t = setTimeout(() => setSearch(searchInput), DEBOUNCE_MS)
    return () => clearTimeout(t)
  }, [searchInput])

  const { data } = useQuery({
    ...orpc.volunteers.list.queryOptions({
      input: { limit: RESULT_LIMIT, search: search || undefined, chapter },
    }),
    enabled,
  })
  const volunteers = data?.volunteers ?? []

  // Remember whichever option was last picked so the trigger keeps showing its label
  // even after a later search no longer includes it in the fetched page.
  const [selectedOption, setSelectedOption] = useState<FilterOption | null>(null)

  // Label stays just the name — it's what the trigger shows once selected, and what the
  // e2e suite matches on. The rest goes in the description, which the search also matches
  // and which stays out of the option's accessible name.
  const describe = (v: (typeof volunteers)[number]) =>
    [
      v.email,
      [v.localGroup, v.country].filter(Boolean).join(', '),
      v.duplicateOf && `duplicate of ${v.duplicateOf.name}`,
    ]
      .filter(Boolean)
      .join(' · ') || undefined
  // A pinned person the search also found keeps the search's details, so typing their email
  // or town still finds them under their group.
  const found = new Map(volunteers.map((v) => [v.id, v]))
  const shown = new Set(exclude)
  const pinnedOptions: FilterOption[] = pinned.flatMap((group) => {
    const people = group.people.filter((p) => !shown.has(p.id))
    for (const p of people) shown.add(p.id)
    if (people.length === 0) return []
    return [
      { value: `__header_${group.title}`, label: group.title, header: true },
      ...people.map((p) => {
        const v = found.get(p.id)
        return { value: String(p.id), label: p.name, description: v && describe(v) }
      }),
    ]
  })
  const volunteerOptions: FilterOption[] = volunteers
    .filter((v) => !shown.has(v.id))
    .map((v) => ({ value: String(v.id), label: v.name, description: describe(v) }))
  const listed = [...pinnedOptions, ...volunteerOptions]
  const options: FilterOption[] = [
    { value: '', label: placeholder },
    ...(selectedOption &&
    selectedOption.value === value &&
    !listed.some((o) => o.value === selectedOption.value)
      ? [selectedOption]
      : []),
    ...pinnedOptions,
    ...(pinnedOptions.length > 0 && volunteerOptions.length > 0
      ? [{ value: '__header_everyone', label: 'Everyone else', header: true }]
      : []),
    ...volunteerOptions,
  ]

  return (
    <FilterDropdown
      id={id}
      label={label}
      ariaLabel={ariaLabel}
      value={value}
      options={options}
      onChange={(v) => {
        setSelectedOption(options.find((o) => o.value === v) ?? null)
        onChange(v)
      }}
      onQueryChange={setSearchInput}
      searchable
      required={required}
      hideLabel={hideLabel}
      triggerClassName={triggerClassName}
    />
  )
}
