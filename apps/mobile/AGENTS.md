# apps/mobile

Expo SDK 58 (React Native 0.88, React 19.3), Expo Router with routes in `src/app/`,
TypeScript, NativeWind 4 (Tailwind 3.4). One app with customer and pro modes. Root `AGENTS.md`
rules apply.

- Native modules go in with `npx expo install <pkg>` so versions match the SDK. A new native
  module needs a new EAS dev build: write "Needs new dev build" under Risks / follow-ups.
- Styling: NativeWind `className`. Colors come from `src/theme/tokens.json` (shared with
  `tailwind.config.js`), provisional until the design system (D2.1, #18). Third-party
  components need `cssInterop` before `className` works on them.
- Data: TanStack Query for server state, Zustand for small client state. Tokens go in
  `expo-secure-store` (D5.4, #32). API types come from `@jack/shared`.
- Strings: `src/i18n/locales/{en,es}.json` through `useTranslation()`; the device language
  picks the catalog, English is the fallback.
- Config: `app.config.ts` reads `APP_VARIANT` (development, preview, production) to suffix the
  name and bundle id, and `EAS_PROJECT_ID`. The API URL is `EXPO_PUBLIC_API_URL`, set per
  profile in `eas.json`.
- EAS profiles: `development` (dev client, device), `development-simulator` (iOS simulator,
  Android APK; used by the emulator portals), `preview`, `production`.
- UI changes need screenshots from the Android emulator and the iOS simulator, including empty
  and error states.

```sh
pnpm --filter @jack/mobile start       # needs a dev build (eas build --profile development-simulator)
pnpm --filter @jack/mobile typecheck
pnpm --filter @jack/mobile lint
pnpm --filter @jack/mobile test        # jest-expo
pnpm --filter @jack/mobile exec expo export --platform android --output-dir dist-ci   # bundle check
```
