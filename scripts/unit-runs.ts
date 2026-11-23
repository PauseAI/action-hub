import fs from 'node:fs'
import path from 'node:path'

/**
 * Each `npm run test:unit` writes its results and coverage under its own directory, named by
 * its pid, and publishes the coverage to `coverage/` once it ends. Runs in the same checkout
 * then never write into each other's reports.
 */

/**
 * Whether a process with this pid is running. Nothing is killed: signal 0 sends no signal, it
 * only asks the kernel whether one could be sent (the `kill -0` idiom). It throws ESRCH when no
 * such process exists, and EPERM when the process exists but belongs to another user, which
 * still counts as alive.
 */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0) // probe only, see above
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export function runDir(root: string, pid: number): string {
  return path.join(root, String(pid))
}

/** Removes the directories of runs whose process has ended. */
export function sweepDeadRunDirs(root: string): void {
  if (!fs.existsSync(root)) return
  for (const name of fs.readdirSync(root)) {
    const pid = Number(name)
    if (Number.isInteger(pid) && !isAlive(pid)) {
      fs.rmSync(path.join(root, name), { recursive: true, force: true })
    }
  }
}

/** Moves a run's coverage to `target`, replacing what was there; a run that made none changes nothing. */
export function publishCoverage(own: string, target: string): void {
  if (!fs.existsSync(own)) return
  fs.rmSync(target, { recursive: true, force: true })
  fs.renameSync(own, target)
}
