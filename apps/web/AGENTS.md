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
- Styling: Tailwind classes using the brand tokens in `src/app/globals.css` `@theme`, the deck
  palette described in `docs/design/README.md` and provisional until the design system (D2.1,
  #18). Colors: `navy-900`, `navy-700`, `green-500`, `green-700`, `white`, `gray-50`,
  `gray-500`, `danger`, `success`, `warning`; radius: `sm`, `md`, `lg`, `xl`, `pill`. They mirror
  `apps/mobile/src/theme/tokens.json` (the source) and `src/theme/tokens.test.ts` fails when the
  two drift. Muted text is `gray-500`, never navy with opacity; `green-500` is decoration only on
  light surfaces, never text.
- The panel (`src/app/admin/`, D16.1, #80) is staff only. `src/lib/session.ts` keeps the API's
  tokens in httpOnly cookies (`jfi_at`, `jfi_rt`: SameSite=Strict, Path=/admin, Secure when
  deployed); client components never receive a token. Pages under `src/app/admin/(panel)/` call
  `requireStaff()`, which checks `GET /v1/auth/me` on every request. Only server actions and
  route handlers may write cookies, so an expired access token goes through
  `/admin/session/refresh` (one refresh, both cookies rotated) and any failure through
  `/admin/session/end`. Each login gets a session id: `jfi_sid` is `<sid>.<user id>` and only
  login sets it; the token cookies are `<sid>.<token>` and count only under the current sid, with
  `/me` answering that user (a late refresh cannot revive a logout or switch user). Both session routes act only on
  same-origin requests (`fromThisSite`). Every API call has the `API_TIMEOUT_MS` deadline, body
  included, and sign-out clears the cookies before it revokes. Server actions keep Next's
  Origin check: never set `serverActions.allowedOrigins`. `/admin` responses are
  `Cache-Control: no-store` (`next.config.ts`).
- UI kit: shadcn/ui components in `src/components/ui/`, written on the deck tokens (no extra
  color variables: `src/theme/tokens.test.ts` allows only the mobile tokens) with `cn()` from
  `src/lib/utils.ts`. Icons from `lucide-react`. TanStack Table comes with #81.
- `src/app/robots.ts` allows indexing only when `APP_ENV=production`.
- UI changes need screenshots at mobile and desktop width in the PR.

```sh
pnpm --filter @jack/web dev        # http://localhost:3000 (cp .env.example .env.local first)
# Panel login locally: run the API, create a staff account with
# `uv run python -m scripts.create_staff_user` (apps/api), open /admin/login.
pnpm --filter @jack/web typecheck  # next typegen + tsc
pnpm --filter @jack/web lint
pnpm --filter @jack/web test       # vitest
pnpm --filter @jack/web build
```
