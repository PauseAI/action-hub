import { staffRoleIn, type ChapterAccess } from './chapter-access'

/**
 * What two accounts share that suggests one person holds both, as an admin merging them is shown
 * it: the same name once case, accents and spacing are set aside; the same Discord handle; the
 * same Signal or WhatsApp number; or the same mailbox. findDuplicatePairs (lib/duplicate-accounts.ts)
 * pairs accounts by the first three in SQL, by these rules. All of it is typed in by whoever holds
 * each account, so it suggests a pair; only the same confirmed mailbox proves it
 * (`sameConfirmedMailbox`).
 */
export type Overlap = 'name' | 'discord' | 'phone' | 'email'

type Account = {
  name: string
  email: string | null
  discordHandle: string | null
  signalNumber: string | null
  whatsappNumber: string | null
}

/** The shortest phone number compared, so a stray digit or two never makes a match. */
export const MIN_PHONE_DIGITS = 7
const GMAIL = new Set(['gmail.com', 'googlemail.com'])

export const nameKey = (name: string) =>
  name.normalize('NFD').replace(/\p{M}/gu, '').trim().replace(/\s+/g, ' ').toLowerCase()

/**
 * The mailbox an address delivers to, or null for none. Only Gmail, which documents it, is taken
 * to ignore dots and a `+tag`; elsewhere either can name a different person's mailbox.
 */
export function mailboxKey(email: string | null): string | null {
  const address = email?.trim().toLowerCase() ?? ''
  const at = address.lastIndexOf('@')
  if (at < 1) return null
  const domain = address.slice(at + 1)
  if (!GMAIL.has(domain)) return address
  const local = address.slice(0, at).split('+')[0].replace(/\./g, '')
  return local ? `${local}@gmail.com` : null
}

/**
 * The proof a staff member may merge on without asking: both addresses confirmed, and both
 * delivering to one mailbox. Anything else is asked of the person (lib/staff-merge.ts).
 */
export function sameConfirmedMailbox(
  a: { email: string | null; emailConfirmed: boolean },
  b: { email: string | null; emailConfirmed: boolean },
) {
  const mailbox = mailboxKey(a.email)
  return a.emailConfirmed && b.emailConfirmed && mailbox !== null && mailbox === mailboxKey(b.email)
}

const phones = (a: Account) =>
  [a.signalNumber, a.whatsappNumber]
    .map((p) => (p ?? '').replace(/\D/g, ''))
    .filter((p) => p.length >= MIN_PHONE_DIGITS)

export function accountOverlap(a: Account, b: Account): Overlap[] {
  const found: Overlap[] = []
  if (nameKey(a.name) && nameKey(a.name) === nameKey(b.name)) found.push('name')
  const discord = (h: string | null) => h?.trim().toLowerCase() || null
  if (discord(a.discordHandle) && discord(a.discordHandle) === discord(b.discordHandle)) {
    found.push('discord')
  }
  const theirs = new Set(phones(b))
  if (phones(a).some((p) => theirs.has(p))) found.push('phone')
  const mailbox = mailboxKey(a.email)
  if (mailbox && mailbox === mailboxKey(b.email)) found.push('email')
  return found
}

/** Each overlap as the merge dialog lists it. */
export const OVERLAP_LABELS: Record<Overlap, string> = {
  name: 'Same name',
  discord: 'Same Discord handle',
  phone: 'Same Signal or WhatsApp number',
  email: 'Same mailbox (one address is an alias of the other)',
}

/** A global admin merges any two accounts; a chapter's lead, two that are both its members. */
export function mayMerge(
  access: ChapterAccess,
  a: { nationalChapterId: number | null },
  b: { nationalChapterId: number | null },
) {
  return (
    access.globalAdmin ||
    (a.nationalChapterId === b.nationalChapterId &&
      staffRoleIn(access, a.nationalChapterId) === 'LEAD')
  )
}
