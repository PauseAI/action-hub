# Remove npm overrides once the parent packages catch up

Size: S. Kind: small fix.

## Problem

`overrides` in `package.json` pins transitive packages that their parents still hold at versions with security advisories. npm applies an override whatever range the parent declares, and Renovate does not flag one that has become unnecessary, so each will outlive its reason and can later force an old major on a parent that needs a newer one:

- `@storybook/builder-webpack5` → `webpack-dev-middleware` 7.4.6 (GHSA-g84c-rxfj-3j2c). Storybook 10.6 asks for `^6.1.2`.
- `@prisma/config` → `effect` 3.22.5 (GHSA-7589-6fvf-x4pw) and `deepmerge-ts` 8.0.2 (GHSA-ggr8-5vv4-36mx). Prisma 6 pins 3.21.0 and 7.1.5 exactly.

## Fix

When Renovate bumps Storybook or Prisma, check whether the parent's own range now reaches a patched version; if so, delete that override, reinstall and confirm `npm audit` stays clear. For Prisma, `prisma.config.test.ts` checks the installed versions.

## Hits

None yet.
