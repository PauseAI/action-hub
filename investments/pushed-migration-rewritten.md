# A migration rewritten after it was pushed breaks that PR's preview

Size: S. Kind: ways of working.

## Problem

A PR's Railway preview keeps its database across pushes, so every migration pushed is applied there. A migration regenerated or renamed after that push fails on the preview (the old one's types and tables are already there), and Prisma then refuses every later migration (P3009) until someone fixes the database by hand in Railway. `prisma migrate resolve --rolled-back` alone doesn't help, since the old migration's objects remain.

## Fix

A line under "Database migrations" in `AGENTS.md`: once pushed, a migration is fixed; change the schema with a new migration, even within the same PR.

## Hits

- 2026-11-11: the notification preferences PR regenerated its migration after the first push; the preview failed with `type "EmailDelivery" already exists`, then P3009 on every deploy, until its database was reset
- 2026-11-18: ses-sender (#412) regenerated its migration twice after pushing (review rounds); the preview crashed on `type "EmailSuppressionReason" already exists` until the PR was closed and reopened for a fresh environment
- 2026-11-25: member-sign-out (#436) renamed its migration after push, to sort after #438's; the preview hit `ADD VALUE` on a value it held, recorded the migration as failed, then P3009 on every deploy until the PR was closed and reopened
