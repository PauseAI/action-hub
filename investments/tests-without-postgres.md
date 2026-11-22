# A session that can't reach Postgres can't run any unit test

Size: M. Kind: tools.

## Problem

Every node test file runs `test/global-setup.ts`, so even a pure test such as `lib/permissions.test.ts` needs Postgres. A session without it gets test results only from CI, and `gh run view --log` downloads from a blob host some sandboxes refuse.

## Fix

A vitest project for tests that need no database, and a script that prints a CI run's failing tests from its annotations (`gh api repos/PauseAI/action-hub/check-runs/<job id>/annotations`).

## Hits

- 2026-10-26: the bug report triage work was written in a host session that couldn't reach Postgres, and went to a PR with no unit or e2e run
- 2026-10-28: the role-based access work wrote its access-matrix tests blind, pushed a draft PR to prove them, and read results from check-run annotations
- 2026-10-26: profile pictures wrote its migration with `prisma migrate diff` between two schema files and verified every database-backed test through CI, a push-and-wait loop per fix
