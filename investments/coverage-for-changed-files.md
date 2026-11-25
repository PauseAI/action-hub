# No quick way to see coverage for only the files a change touched

Size: S. Kind: tools.

## Problem

Each uncovered line is found by a full `check-all` (about 7 minutes), so a change with four stray lines costs four extra runs.

## Fix

An npm script that runs the unit tests with coverage limited to files changed since `main` and prints their uncovered lines.

## Hits

- 2026-10-15 (x2): Phase 3 needed four extra runs for single lines (a cron registry wrapper, a dialog's error toast, an import path no test fed a new field, a chip's null guard), and its UX-review follow-up a fifth (a hint's click handler)
- 2026-11-25: deputy-findable's CI run was the first to find two uncovered lines (a lead viewed by an admin, a dialog's Cancel); `vitest --coverage.include` with zeroed thresholds printed no table locally
