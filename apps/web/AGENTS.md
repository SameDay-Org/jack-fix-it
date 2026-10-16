# apps/web

Next.js 16 (App Router, React 19.3, TypeScript), Tailwind v4, i18next. Root `AGENTS.md` rules
apply.

- Routes: the landing and SEO pages go in `src/app/(marketing)/`, the admin/BDC panel in
  `src/app/admin/` (its layout sets `noindex`). Server components are the default.
- Strings: `src/i18n/locales/{en,es}.json`. Server components translate with
  `getT(locale)` from `src/i18n/server.ts`, which builds a fresh i18next instance per call.
- API calls: `src/lib/api.ts`, typed from `@jack/shared`. Server-side requests use
  `API_INTERNAL_URL` (the api service's private domain on Railway). API types are generated,
  never written by hand.
- Styling: Tailwind classes using the brand tokens in `src/app/globals.css` `@theme` (navy,
  orange, white, gray-light), provisional until the design system (D2.1, #18).
- The panel's UI kit (shadcn/ui, TanStack Table) comes with D16.1 (#80).
- `src/app/robots.ts` allows indexing only when `APP_ENV=production`.
- UI changes need screenshots at mobile and desktop width in the PR.

```sh
pnpm --filter @jack/web dev        # http://localhost:3000 (cp .env.example .env.local first)
pnpm --filter @jack/web typecheck  # next typegen + tsc
pnpm --filter @jack/web lint
pnpm --filter @jack/web test       # vitest
pnpm --filter @jack/web build
```
