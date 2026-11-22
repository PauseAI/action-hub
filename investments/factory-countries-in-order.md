# createChapter hands out countries in order, so a hard-coded country collides

Size: S. Kind: small fix.

## Problem

`createChapter` (`test/factories.ts`) gives each new chapter the first enabled country not yet taken, alphabetically. A test that names a country as "somewhere else" (`'Ghana'`, `'Kenya'`) works only while fewer chapters are made before it in the same file. Adding a test earlier in `server/routers/volunteers.test.ts` made the country-transfer test's own chapter Kenya, and it failed with a refusal that never came.

## Fix

Give the factories a helper for "a country other than this chapter's" (the next enabled country not equal to it), and use it wherever a test names a foreign country.

## Hits

- 2026-11-21: `volunteers.updateMe and chapters` started failing once two tests above it each made a chapter; worked round in the test, ~15 min
