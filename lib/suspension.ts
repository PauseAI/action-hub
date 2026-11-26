import { ORPCError } from '@orpc/server'
import { SUPPORT_EMAIL } from './support-email'
import { prisma } from './prisma'

/** What someone suspended is told when they try to sign in. */
export const SUSPENDED_MESSAGE = `This account is suspended. Contact ${SUPPORT_EMAIL} if you think this is a mistake.`

/**
 * Refuses to put a suspended account on any work, as the "not yet approved" checks beside it
 * refuse an applicant.
 */
export function assertActive(person: { name: string; suspendedAt: Date | null }) {
  if (person.suspendedAt) {
    throw new ORPCError('BAD_REQUEST', { message: `${person.name} is suspended` })
  }
}

/** `assertActive` for someone known only by id; a missing account is left to the caller. */
export async function assertActiveById(
  volunteerId: number,
  db: { volunteer: Pick<typeof prisma.volunteer, 'findUnique'> } = prisma,
) {
  const person = await db.volunteer.findUnique({
    where: { id: volunteerId },
    select: { name: true, suspendedAt: true },
  })
  if (person) assertActive(person)
}
