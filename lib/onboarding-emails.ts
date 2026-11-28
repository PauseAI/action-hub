import { env } from './env'
import type { OnboardingEmail } from './email'
import { ONBOARDING_PATH, formatCallTime, respondUrl } from './onboarding'

type Call = { startsAt: Date; actionToken: string; lumaUrl: string | null }

const page = () => ({ label: 'Open Global Onboarding', url: `${env.APP_URL}${ONBOARDING_PATH}` })

const whereLines = (call: Call, meetLink: string | null) =>
  [
    meetLink ? `It runs on Google Meet: ${meetLink}` : null,
    call.lumaUrl ? `Luma page: ${call.lumaUrl}` : null,
  ].filter((l): l is string => l !== null)

export const ONBOARDING_SUBJECTS = {
  reminder: (at: Date) => `Are you on for the welcome call on ${formatCallTime(at)}?`,
  cover: (at: Date) => `Can you host the welcome call on ${formatCallTime(at)}?`,
  swapped: (by: string) => `${by} swapped welcome calls with you`,
  assigned: (at: Date) => `You're hosting the welcome call on ${formatCallTime(at)}`,
}

/** The host's reminder, whose two buttons need no sign-in. */
export function reminderEmail(call: Call, meetLink: string | null): OnboardingEmail {
  return {
    subject: ONBOARDING_SUBJECTS.reminder(call.startsAt),
    heading: `You're hosting the welcome call on ${formatCallTime(call.startsAt)}`,
    paragraphs: [
      "Please let the team know you're still on. If you can't make it, ask for cover and everyone else on the team is asked to take it.",
      ...whereLines(call, meetLink),
    ],
    buttons: [
      { label: "I'm on", url: respondUrl(env.APP_URL, call.actionToken, 'on') },
      { label: 'I need cover', url: respondUrl(env.APP_URL, call.actionToken, 'cover') },
    ],
  }
}

export type CoverReason = { kind: 'cover' | 'unconfirmed'; hostName: string } | { kind: 'none' }

const coverLine = (reason: CoverReason) =>
  reason.kind === 'cover'
    ? `${reason.hostName} can't make it and has asked for cover.`
    : reason.kind === 'unconfirmed'
      ? `${reason.hostName} hasn't said they're on yet, so it may need someone else.`
      : 'Nobody is hosting it yet.'

/** Asks the rest of the team to take a call. */
export function coverEmail(call: Call, reason: CoverReason): OnboardingEmail {
  return {
    subject: ONBOARDING_SUBJECTS.cover(call.startsAt),
    heading: `Can you host the welcome call on ${formatCallTime(call.startsAt)}?`,
    paragraphs: [
      coverLine(reason),
      'If you can host it, open Global Onboarding and press "I\'ll host". The first to take it hosts it.',
    ],
    buttons: [page()],
  }
}

/** Tells the other side of a swap which call they host now. */
export function swappedEmail(by: string, nowHosting: Date, noLongerHosting: Date): OnboardingEmail {
  return {
    subject: ONBOARDING_SUBJECTS.swapped(by),
    heading: `You now host the welcome call on ${formatCallTime(nowHosting)}`,
    paragraphs: [
      `${by} swapped calls with you: you host the call on ${formatCallTime(nowHosting)} instead of the one on ${formatCallTime(noLongerHosting)}.`,
      'If that is not what you agreed, open Global Onboarding to swap back or ask for cover.',
    ],
    buttons: [page()],
  }
}

/** Tells a member the lead put them down to host a call. */
export function assignedEmail(by: string, call: Call, meetLink: string | null): OnboardingEmail {
  return {
    subject: ONBOARDING_SUBJECTS.assigned(call.startsAt),
    heading: `You're hosting the welcome call on ${formatCallTime(call.startsAt)}`,
    paragraphs: [
      `${by} has put you down to host it. You'll get a reminder a few days before.`,
      ...whereLines(call, meetLink),
    ],
    buttons: [page()],
  }
}
