# Gantt and import e2e specs failed together for an hour, then passed

Size: S. Kind: small fix.

## Problem

On 2026-11-25, `e2e/tests/39-work-item-gantt.spec.ts` (six tests) and
`40-project-import-export.spec.ts` (one) failed on every run between about 17:45 and 18:00 UTC,
then passed on every run from 18:02, on `main` and on a branch that touched neither area. One
failure was a bar's dates three days off what the test expected (`13 September 2027` expected,
`10 September 2027` shown), which suggests a test that computes dates from the real clock and
crosses a day or week boundary in some time zone. Not yet reproduced: pin the clock to just
before 18:00 UTC and run the two specs.

## Fix

Find the date the Gantt tests derive from "now", and give the spec a fixed clock
(`page.clock.setFixedTime`) or dates far enough ahead that the boundary cannot move them.

## Hits

- 2026-11-25: three runs failed (one full check-all), and bisecting against `main` cost ~25 min
