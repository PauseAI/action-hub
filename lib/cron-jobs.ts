import { finishCronRun, recordCronRun, type CronTriggerSource } from '@/lib/cron-audit'
import { runDigestJob } from '@/jobs/digest'
import { runNudgesJob } from '@/jobs/nudges'
import { runApplicationsSummaryJob, runApplicationsAnonymisationJob } from '@/jobs/applications'
import { runCspSummaryJob } from '@/jobs/csp-summary'
import { runDeadlineRemindersJob } from '@/jobs/deadline-reminders'
import { runNotificationDigestJob } from '@/jobs/notification-digest'
import { runEmailHousekeepingJob } from '@/jobs/email-housekeeping'
import { runEmailCapCheckJob } from '@/jobs/email-cap-check'
import {
  CRON_JOB_INFO,
  CRON_JOB_NAMES,
  DAILY_JOBS_HOUR_UTC,
  type CronJobName,
} from '@/lib/cron-job-names'
import { prisma } from '@/lib/prisma'
import { startOfUtcDay } from '@/lib/schedule'

export { CRON_JOB_NAMES, type CronJobName } from '@/lib/cron-job-names'

export type CronJobRunners = Record<CronJobName, () => Promise<unknown>>

const realRunners: CronJobRunners = {
  digest: runDigestJob,
  nudges: runNudgesJob,
  'applications-summary': runApplicationsSummaryJob,
  'applications-anonymisation': runApplicationsAnonymisationJob,
  'csp-summary': runCspSummaryJob,
  'deadline-reminders': runDeadlineRemindersJob,
  'notification-digest': runNotificationDigestJob,
  'email-housekeeping': runEmailHousekeepingJob,
  'email-cap-check': runEmailCapCheckJob,
}

let current: CronJobRunners = realRunners

/** The implementations behind CRON_JOBS; tests swap them with `setCronJobRunners`. */
export function cronJobRunners(): CronJobRunners {
  return current
}

/** Replaces the job implementations; `undefined` restores the real ones. Returns the previous set. */
export function setCronJobRunners(runners: CronJobRunners | undefined): CronJobRunners {
  const previous = current
  current = runners ?? realRunners
  return previous
}

/** Each job by name, wrapped so every run is recorded in the cron audit table. */
export const CRON_JOBS = Object.fromEntries(
  CRON_JOB_NAMES.map((name) => [
    name,
    (triggeredBy?: CronTriggerSource) => recordCronRun(name, () => current[name](), triggeredBy),
  ]),
) as Record<CronJobName, (triggeredBy?: CronTriggerSource) => Promise<unknown>>

/** Whether the newest kept scheduled run of `name` before this one failed. */
async function lastRunFailed(name: CronJobName): Promise<boolean> {
  const previous = await prisma.cronJobRun.findFirst({
    where: { jobName: name, triggeredBy: 'cron' },
    orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
    skip: 1,
    select: { status: true },
  })
  return previous?.status === 'error'
}

/**
 * Hourly runs that found nothing to do, left out of the audit history so it is not mostly
 * empty runs. Errors and admin runs are always kept, and so is the cap check's first pass after
 * a failure, so the history shows it recovered.
 */
const QUIET_RUN: Partial<Record<CronJobName, (result: unknown) => Promise<boolean> | boolean>> = {
  'notification-digest': (r) => (r as { due?: number }).due === 0,
  'email-cap-check': async () => !(await lastRunFailed('email-cap-check')),
}

/** Jobs that read what the others did, so they start once the rest have settled. */
const RUNS_LAST: readonly CronJobName[] = ['email-cap-check']

/** A run still marked running after this long is taken to have died. */
const STALE_RUN_MS = 6 * 60 * 60 * 1000

/** Failed tries of a daily job in one UTC day before it waits for the next day. */
const MAX_DAILY_ATTEMPTS = 3

type Db = Pick<typeof prisma, 'cronJobRun'>

type DailyJobState = 'due' | 'not due' | 'out of tries'

/**
 * Whether daily job `name` is due at `now`: from {@link DAILY_JOBS_HOUR_UTC}, until a scheduled
 * run of it succeeds that UTC day. A run still going holds the day; a failed or dead one is tried
 * again on the next trigger, up to {@link MAX_DAILY_ATTEMPTS} tries a day, after which it is out
 * of tries until the next day. An admin's Run now counts for none of this.
 */
async function dailyJobState(name: CronJobName, now: Date, db: Db): Promise<DailyJobState> {
  if (now.getUTCHours() < DAILY_JOBS_HOUR_UTC) return 'not due'
  const runs = await db.cronJobRun.findMany({
    where: { jobName: name, triggeredBy: 'cron', startedAt: { gte: startOfUtcDay(now) } },
    select: { status: true, startedAt: true },
  })
  const live = (r: { startedAt: Date }) => now.getTime() - r.startedAt.getTime() < STALE_RUN_MS
  if (runs.some((r) => r.status === 'success' || (r.status === 'running' && live(r)))) {
    return 'not due'
  }
  return runs.length < MAX_DAILY_ATTEMPTS ? 'due' : 'out of tries'
}

/**
 * Starts today's run of daily job `name` if it is due, and returns its audit row's id;
 * otherwise why not. The check and the start share a transaction under a lock on the job's
 * name, so two triggers at once start it only once.
 */
async function claimDailyRun(
  name: CronJobName,
  now: Date,
): Promise<number | Exclude<DailyJobState, 'due'>> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`cron:${name}`}))`
    const state = await dailyJobState(name, now, tx)
    if (state !== 'due') return state
    const run = await tx.cronJobRun.create({
      data: { jobName: name, status: 'running', triggeredBy: 'cron', startedAt: now },
      select: { id: true },
    })
    return run.id
  })
}

/**
 * One call of the hourly cron trigger at `now`: every hourly job, and each daily job that is
 * due. Each result is the job's own, its error, or `{ skipped: 'not due' }`. A daily job out of
 * tries reports an error on every trigger until the next day, so the failure stays visible.
 */
export async function runScheduledJobs(now: Date = new Date()): Promise<Record<string, unknown>> {
  const run = async (name: CronJobName) => {
    if (CRON_JOB_INFO[name].every === 'hour') {
      return recordCronRun(name, () => current[name](), 'cron', QUIET_RUN[name])
    }
    const claim = await claimDailyRun(name, now)
    if (claim === 'not due') return { skipped: 'not due' }
    if (claim === 'out of tries') {
      throw new Error(`failed ${MAX_DAILY_ATTEMPTS} times today; next try tomorrow`)
    }
    return finishCronRun(claim, () => current[name]())
  }
  const settle = async (names: CronJobName[]) =>
    (await Promise.allSettled(names.map(run))).map((r, i) => [names[i], r] as const)
  const first = await settle(CRON_JOB_NAMES.filter((n) => !RUNS_LAST.includes(n)))
  const last = await settle(CRON_JOB_NAMES.filter((n) => RUNS_LAST.includes(n)))
  return Object.fromEntries(
    [...first, ...last].map(([name, r]) => [
      name,
      r.status === 'fulfilled' ? r.value : { error: String(r.reason) },
    ]),
  )
}
