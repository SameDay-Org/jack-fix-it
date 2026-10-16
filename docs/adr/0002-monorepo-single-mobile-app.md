# 0002. One monorepo and a single mobile app for customers and pros

- **Status:** accepted
- **Date:** 2026-10-16

Everything lives in one repository: `apps/api` (FastAPI and the ARQ worker), `apps/web`
(landing and admin/BDC panel in one Next.js project), `apps/mobile` (Expo) and
`packages/shared` (TypeScript types generated from the API's OpenAPI schema). One repo keeps the
API contract and its clients in the same PR, and CI fails when the generated types are stale.
JavaScript uses pnpm workspaces; the API uses uv.

Customers and pros use **one** React Native app, with the mode chosen at sign up. About half
the screens are shared (login, chat, profile, job), and publishing one app instead of two saves
days of store review. Separate apps stay possible later if the product grows.

## Consequences

- pnpm uses `node-linker=hoisted`, which Expo's Metro bundler needs in a pnpm monorepo.
- Cross-layer features are split into an API issue first (it regenerates `packages/shared`),
  then the web or mobile issues that use it.
