# Races that only show under full-suite load cost a full check-all each

Size: M. Kind: tools.

## Problem

A test that races only under full-suite load fails one `check-all` run, passes 8/8 when run alone, and the next race shows only on the next run of up to ten minutes. The causes repeat: a `getBy…` or `getByText` read before a refetch or query lands (a textarea's value mirrored into its text counts as "on screen"), a `vi.waitFor` or `findBy…` default outlasted under load, an element looked up once and then replaced by a refetch, and a wait for any alert satisfied by an earlier toast. The access matrix's timeouts were each commit waiting on fsync, which test connections now skip (`withoutCommitSync` in `test/pg.ts`); its hits are kept as the record of that cost.

## Fix

A script that reruns one suspect file under the same parallel load (all unit files at once, only the suspect repeated), so a race is found in one pass instead of one per full run. `TEST_RPC_JITTER_MS` (`test/rpc-fetch.ts`) already reorders a component test's requests the way load does, which finds many such races in a single file's reruns.

`flaky-tests-under-load-sweep.md` covers the same cost from the other side (several full runs, every failure listed); doing either may be enough.

## Hits

- 2026-09-24 (x3): `ProjectEditor.test.tsx` failed three ways across four runs (a 5 s database poll, a title long enough to start autosave, a real bug dropping edits made during the first autosave); e2e `01` reloaded before a background mark-read landed; e2e `16` read a reply's text in the box as proof it was saved; `ProjectEditor` read a button that follows a refetch with `getBy…`
- 2026-10-15 (x5): the Add Task button read "Adding…" while autosave created the draft; the Inbox test opened a row before it showed as read; e2e `36` Save Changes still "Saving…" after 10 s; e2e `34` a project pushed off the overview by other specs' projects; e2e `23` a reload's aborted request signed the user out; the owner-picker debounce outlived its picker; `ProjectEditor` clicked a still-disabled Submit, one per ten-minute run
- 2026-10-15: main's first CI run hit e2e `30`, where `transferProjectOwnership` waited for any alert and an approval toast still up satisfied it
- 2026-10-16: three `check-all` runs in a row each failed one unrelated unit file (`ProjectEditor.test.tsx`, `app/quick-tasks/page.test.tsx`, `server/routers/quickTasks.test.ts`), each passing alone in under 40 s
- 2026-10-17: passed `check-all` locally, failed in CI: two component tests acted before a query had loaded
- 2026-10-23: `ProjectEditor` Submit opened its dialog only after a fresh fetch that outlasted `findByText`'s default
- 2026-10-26: `app/signup/page.test.tsx` resend outlasted `vi.waitFor`'s default, and the fake clock it left behind timed out every later test in the file, so one race read as ten failures
- 2026-11-05 (x2): the access matrix timed out under full-suite load in two runs, passing eight reruns alone
- 2026-11-11 (x3): e2e `39` polled `lagDays` past 5 s; `scripts/disposable-db.test.ts`'s `DROP DATABASE` hook outlasted 10 s twice; e2e `09` failed 3 in 11 on `16`'s race, found in one read from a trace with both pages' network timings (`postComment` in `e2e/actions/ui.ts` now waits for the box to empty); `jobs/deadline-reminders.test.ts` ran past the node project's 5 s default (raised to 20 s); `ProjectEditor` "admins publish org projects directly" failed alone 3 in 6 even after cancelling in-flight queries, cause not yet found
- 2026-11-11: `tasks-access` "are reviewed by its admins, owner and deputies" timed out at 20 s, 8/8 alone
- 2026-11-11: three `tasks-access` tests timed out; with the host loaded the file failed two of 17 alone, on `main` too
- 2026-11-12: `check-all` timed out seven tests across the access matrix, `cron-audit`, `concurrency` and `skills`; run alone, `tasks-access` still failed two of 17 and `projects-access` one of 23 at 20 s, in a change touching no code
- 2026-11-12 (x3): notification preferences' `check-all`s each timed out `tasks-access`; the file took 112–165 s in the suite and, with the host loaded, failed alone at 122–143 s, on the base commit too
- 2026-11-16: `tasks-access` "are reviewed by its admins, owner and deputies" (three matrix sweeps in one test) timed out at 20 s in `check-all`, 8/8 alone at 55–87 s per file; split into one test per sweep; the next `check-all` timed out 12 tests across `tasks-access`, `projects-access`, `projects-update`, `projectPorting` and `bugReports`, and alone `projects-access` still failed two of 23 at 20 s (load average about 5 on 12 cores)
- 2026-11-18: `check-all` failed five e2e tests in `38` and `39` (a 5 s `lagDays` poll, a 500 from `projects.getById`, missing elements), in a change touching neither; both files passed 16/16 run alone
- 2026-11-18 (x2): a nudges-job change's `test:unit` timed out `projects-access` and `tasks-access` (two tests); alone on the base commit the pair failed five of 42 at 20 s
- 2026-11-18: ses-sender's `check-all` (load average about 20 on 12 cores) timed out 17 tests across the access matrix, settings, bugs-triage, porting and primitives; rerun alone at that load, 16 still timed out; at load 5, 52/52 passed on the branch and on its base commit
- 2026-11-20 (x2): a Railway config change touching no app code: `check-all` timed out `tasks-access` and failed `app/coordinate/page.test.tsx` (the "Australia" checkbox not yet rendered), 8/8 alone; the `test:unit` rerun timed out `projects-access` instead
- 2026-11-21: a backup change touching no router: `check-all` timed out 40 tests in 14 unrelated files (host load average about 23 on 12 cores); rerun alone at load 12, `projects-access` and `tasks-access` still timed out nine
- 2026-11-21: ses-sender's merge of main: `check-all` (load average about 17) timed out five `projects-access`/`tasks-access` tests; alone at that load, eight of 42 timed out
- 2026-11-21: with the host's load average near 25, `check-all` timed out tests across a dozen files at 20 s, and `volunteers.test.ts` alone still timed out a different test each run, on `main` too; one aborted `check-all`, CI used as the full run
- 2026-11-24 (x3): two dependency-only PRs (Dependabot highs): `check-all` on the second and two `test:unit` reruns of the first timed out 3–23 tests across the access matrix and other router files while other worktrees loaded the host (load average 4–9 on 12 cores); `projects-access` + `tasks-access` alone failed 2–5 of 42 on the branch and on `main`; CI passed both
- 2026-11-24: a digest-job change touching no router: `check-all` timed out `projects-access` "a draft stops being one once published" at 20 s; alone, with a review running beside it, one of 23 still timed out
- 2026-11-24: an email-cap change's `check-all` (load average about 10 on 12 cores, beside another session's run) timed out or failed about 35 tests across 15 files, `cron-jobs` among them; the touched files passed 16/16 alone
- 2026-11-24: a Render standby change touching no router or component: `check-all` (load average about 15 on 12 cores) timed out tests in 11 unrelated files across the access matrix, `calls`, `dashboard-privacy` and `ProjectEditor`; rerun alone at load 11 they still timed out, CI used as the full run
- 2026-11-25: render-standby rebase: `check-all` (load average about 4 on 12 cores) timed out five `tasks-access`/`projects-access` tests at 20 s; the pair passed 42/42 alone, and CI passed
- 2026-11-25 (x3): three small UX PRs: `check-all` timed out 1–4 access-matrix tests on the first and 13 tests across `ProjectEditor`, the project page, `misc`, `cron-jobs`, `projects-tasks`, `projects-helpers` and the access matrix on the second (load average 10–13 on 12 cores); each touched file passed alone; CI used as the full run; `app/settings/page.test.tsx` also raced a second Save while the first save's `onSuccess` still showed "Saving…" (fixed by waiting for the button)
- 2026-11-25 (x3): task-joining (offers to help): `check-all` at load about 15 timed out 25 tests in 15 files (12-minute run), all passing together once load dropped; a new 15-test file failed one or two tests in two of eight solo runs, each a whole run slowed from 14 s to 57 s; `projects-helpers` + `projects-interests` alone swung from 12 s to 56 s between identical runs. CI used as the full run
- 2026-11-25 (x4): main's CI failed on `ProfilePictureSettings` (a held lookup claimed by the wrong request); sweeping the flaky files with `TEST_RPC_JITTER_MS` found three more: the task page's Past plan box replaced under a click, `ProjectEditor` publishing before its task had saved (the cause not found on 11 Nov), and a previous test's request answering 401 into the next and signing its page out
- 2026-11-25 (x3): requests for help: `check-all` and `test:unit` at load average 13–19 took 11 minutes and timed out 7–15 unrelated tests (access matrix, `ProjectEditor`, admin pages) on three runs, each file passing alone; a concurrent `vitest` run in the same worktree also clobbered the coverage directory. CI used as the full run (before `withoutCommitSync` landed)
