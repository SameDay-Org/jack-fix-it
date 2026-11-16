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
  `gray-500`, `danger`, `success`, `warning`, `receipt-seen` (the chat "seen" tick, on navy
  only: 1.8:1 on white); radius: `sm`, `md`, `lg`, `xl`, `pill`. They mirror
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
- Panel pages that call staff routes take the bearer from `staffAuth()` (`src/lib/session.ts`:
  `requireStaff()` first, then the login's access token) and spread it into `apiGet` /
  `apiPatch`, with `params` for the path's `{placeholders}` and `query` for its query string
  (`src/lib/api.ts`). A server action is a public endpoint: it validates its input and takes
  the bearer from `staffActionAuth()`, never `staffAuth()` or `requireStaff()`. An action must
  not redirect to `/admin/session/refresh` or `/admin/session/end`: Next follows an action's
  redirect on the server and drops its Set-Cookie, so the refresh token would rotate while the
  browser kept the old cookies. `staffActionAuth()` renews or ends the session in place.
  Support tickets (#274) live in `src/app/admin/(panel)/support/`.
- UI kit: shadcn/ui components in `src/components/ui/`, written on the deck tokens (no extra
  color variables: `src/theme/tokens.test.ts` allows only the mobile tokens) with `cn()` from
  `src/lib/utils.ts`. Icons from `lucide-react`. TanStack Table comes with #81.
- User-authored text shown to anyone (review comments first: the public pro profile, #78, and
  any panel view of reviews) renders as escaped plain text only: a React text node, never
  `dangerouslySetInnerHTML`, no markdown and no auto-linked URLs, emails or phones. The API's
  contact redaction is not HTML sanitization: `<svg onload=alert(390)>` is stored and returned
  verbatim as a JSON string, so only the rendering keeps it inert (#392).
- The product showcase (#403) is `src/app/(showcase)/`: `/app` in English and `/es/app` in
  Spanish, both static, plus the legal placeholders the footer links to (`/terms`, `/privacy`
  and their `/es` twins, `noindex` until the texts are approved). Its code is
  `src/features/showcase/`; the routes only pick the language.
  - Its layout loads Plus Jakarta Sans from `src/features/showcase/fonts/` (`next/font/local`,
    license beside the file). No other route uses that font.
  - App screens come from the typed manifest `src/features/showcase/media.ts`; the files are in
    `public/showcase/`. Only real captures of the app: no mockups, and an entry is a
    `placeholder` until its final footage replaces it (`media.test.ts` checks the files, their
    sizes and both languages' text alternatives).
  - Copy rules, on top of the root ones: no fee or take rate, no store badge or download link
    while the app is not in the stores, no form without a working endpoint
    (`showcase-page.test.ts` fails on a forbidden word in either language). FAQ answers reuse
    the mobile app's help texts.
  - The site has one root layout, so `<html lang>` is `en` in the server's HTML of every
    route. A Spanish page wraps its content in `lang="es"` and `html-lang.tsx` sets
    `<html lang>` in the browser. A server-rendered `lang` needs a root layout per route group.
  - Keep its client JavaScript small: components are server components unless they need the
    browser, and a client component does not import `cn` (it would ship tailwind-merge).
    `pnpm --filter @jack/web check:bundle`, after a build, fails when the page's first-load
    JavaScript passes 150 KB gzip; CI runs it.
  - `SITE_URL` (optional, read at build time) gives the page its canonical, `hreflang` and
    Open Graph addresses; without it the page has none.
- The mascot is `src/features/mascot/mascot.tsx`: `<Mascot pose size title className>` with
  the poses `wave`, `point`, `celebrate`, `peek`, `thinking` and `tools`. Today's drawing is a
  placeholder; the final character replaces the drawing, not the props.
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
