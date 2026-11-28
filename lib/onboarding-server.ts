import type { Prisma } from '@/generated/prisma/client'
import { generateAuthToken } from './auth'
import { ADDRESSABLE } from './calls'
import { sendOnboardingCallEmail, type OnboardingEmail } from './email'
import { logger } from './logger'
import { prisma } from './prisma'

/** Who on the team can be emailed: their account is live and they have an address. */
export const REACHABLE = {
  deletedAt: null,
  suspendedAt: null,
  email: { not: null },
} satisfies Prisma.VolunteerWhereInput

/** Who may join the team: the same accounts a coordinator's call may reach. */
export const ELIGIBLE = ADDRESSABLE

export const newActionToken = generateAuthToken

/** A call's fields reset whenever its host changes, so the new host starts afresh. */
export const freshHost = (hostId: number | null, confirmedAt: Date | null = null) => ({
  hostId,
  confirmedAt,
  coverRequestedAt: null,
  remindedAt: null,
  teamAskedAt: null,
  actionToken: newActionToken(),
  // The host is a host of the Luma event too.
  lumaStale: true,
})

export async function onboardingSettings() {
  const settings = await prisma.onboardingSettings.findUnique({ where: { id: 1 } })
  return {
    meetLink: settings?.meetLink ?? null,
    lumaTitle: settings?.lumaTitle ?? null,
    lumaDescription: settings?.lumaDescription ?? null,
  }
}

export const meetLink = async () => (await onboardingSettings()).meetLink

/** Sends `email` to `to`; a failure is logged, never thrown, so one bad address stops nothing. */
export async function emailMember(
  to: { name: string; email: string | null },
  email: OnboardingEmail,
): Promise<boolean> {
  if (!to.email) return false
  try {
    return await sendOnboardingCallEmail({ to: to.email, name: to.name, email })
  } catch (err) {
    logger.error({ err, subject: email.subject }, 'onboarding email failed')
    return false
  }
}

/** The team's reachable members, except `exceptId`. */
export async function reachableTeam(exceptId: number | null) {
  const rows = await prisma.onboardingMember.findMany({
    where: {
      volunteer: REACHABLE,
      ...(exceptId !== null && { NOT: { volunteerId: exceptId } }),
    },
    select: { volunteer: { select: { id: true, name: true, email: true } } },
  })
  return rows.map((r) => r.volunteer)
}
