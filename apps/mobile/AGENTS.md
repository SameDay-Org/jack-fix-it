# apps/mobile

Expo SDK 58 (React Native 0.88, React 19.3), Expo Router with routes in `src/app/`,
TypeScript, NativeWind 4 (Tailwind 3.4). One app with customer and pro modes. Root `AGENTS.md`
rules apply.

- Native modules go in with `npx expo install <pkg>` so versions match the SDK. A new native
  module needs a new EAS dev build (steps below): write "Needs new dev build" under Risks /
  follow-ups.
- Styling: NativeWind `className`. Tokens are the deck palette, radius and type scales from
  `docs/design/README.md`, held in `src/theme/tokens.json` and mapped by `tailwind.config.js`
  (`bg-navy-900`, `rounded-lg`, `text-headline`), provisional until the design system (D2.1,
  #18). Spacing is Tailwind's scale on a 4-pt grid (`metro.config.js` sets rem 16). The bubble
  shadow and continuous corners come from `src/theme`. Third-party components need `cssInterop`
  before `className` works on them.
- Screens: every route renders inside `Screen` (`src/components/ui`), the one owner of the
  status-bar style (`bar="hero"`: light icons over navy-900; `bar="light"`: dark icons over
  gray-50) and of the top safe-area backdrop, which stays outside scrolling content. The root
  layout mounts no `StatusBar`, and ESLint rejects `expo-status-bar` or safe-area view imports
  in `src/app` (`eslint.config.js`).
- Liquid Glass: only through `GlassSurface` (`src/components/ui`): `tone` light | dark,
  `shape` pill | xl | lg, `interactive`. Native `GlassView` on iOS 26+ when
  `isLiquidGlassAvailable()` and Reduce Transparency is off (live, `useReduceTransparency`);
  otherwise a solid token surface with the same shape (opaque white with the bubble shadow, or
  solid navy-700); while the preference is still unknown it renders the solid surface too. Controls layer only, never content cards; ESLint rejects
  `expo-glass-effect` anywhere else (ADR 0008).
- Sheets: a route presented with `sheetOptions(detents)` from its Stack (`<Stack.Screen name="x"
options={sheetOptions([0.5, 0.95])} />`, or `"fitToContents"`), rendering `SheetContent`
  (title, body, actions; safe area and keyboard handled). With `"fitToContents"` the route also
  passes `fitToContents` to `SheetContent`: the sheet takes the content's height, and Android
  hides a fit-to-contents sheet whose root fills. Native form sheet: system glass on iOS 26+,
  same detents on Android. No sheet library.
- Toasts: `showToast({ message, tone })` from anywhere; one at a time, `motion.toastMs` long,
  rendered by the `ToastHost` the root layout mounts. Dismiss text is `common.dismiss`.
- Data: TanStack Query for server state, Zustand for small client state. Tokens go in
  `expo-secure-store` (D5.4, #32). API types come from `@jack/shared`.
- Strings: `src/i18n/locales/{en,es}.json` through `useTranslation()`; the device language
  picks the catalog, English is the fallback.
- Config: `app.config.ts` reads `APP_VARIANT` (development, preview, production) to suffix the
  name and bundle id. The EAS owner and project id are public constants there. The API URL is
  `EXPO_PUBLIC_API_URL`, set per profile in `eas.json`.
- EAS profiles: `development` (dev client, device), `development-simulator` (iOS simulator,
  Android APK; used by the emulator portals), `preview`, `production`.
- UI changes need screenshots from the Android emulator and the iOS simulator, including empty
  and error states.

```sh
# Dev client (not Expo Go): build once on EAS, install the APK, then start Metro for it.
npx eas-cli build --profile development-simulator --platform android   # needs `eas whoami`
adb install <downloaded>.apk                                            # com.jackfixit.app.dev
pnpm --filter @jack/mobile exec expo start --dev-client
pnpm --filter @jack/mobile typecheck
pnpm --filter @jack/mobile lint
pnpm --filter @jack/mobile test        # jest-expo
pnpm --filter @jack/mobile exec expo export --platform android --output-dir dist-ci   # bundle check
```

## Mobile craft bar

Every mobile change ships as if a senior mobile engineer and a senior product designer built it
together. Nothing may look or read like it was vibe-coded. The design reference is
`docs/design/` (brief + slides); the visual language is ADR 0008.

**Design**

- **Platform-native first.** On iOS 26+ the app uses real Liquid Glass for the navigation and
  controls layer: tab bar, top bars, sheets, floating buttons, toasts. Native navigation gestures,
  haptics on meaningful actions (submit, accept, confirm). On Android it feels like Android:
  ripple, predictive back, edge-to-edge. No web-in-a-wrapper patterns.
- **Shape language: bubbles and smooth edges.** Content sits on soft white "bubble" surfaces with
  large continuous-corner radii. Buttons and chips are pills, icon tiles are circles or squircles,
  and callouts are chat bubbles. Hero areas are deep navy with lime-green accents, as in the
  deck. No sharp corners, no hairline-boxed forms, no default-looking controls.
- **Tokens only.** Every color, radius, spacing, type style, shadow and duration comes from the
  theme. A new pattern goes into the component kit (`src/components/ui/`), never inline.
- **Hierarchy and rhythm.** 4-pt spacing grid, generous whitespace, one primary action per
  screen, one headline and one supporting line, aligned edges.
- **Every state designed.** Loading uses skeletons shaped like the final layout. Empty states say
  what to do next. Errors say what happened and offer a retry. Offline and partial-data states are
  covered too. No spinner on a blank screen, no layout jump when data arrives.
- **Motion with purpose.** 150–300 ms, spring-based, interruptible. Respects Reduce Motion and
  Reduce Transparency (glass falls back to solid). No decorative animation.

**Engineering**

- **Feels fast.** Press feedback within 100 ms, 60 fps on a mid-range Android, virtualized lists,
  sized and cached images, optimistic UI where the API allows.
- **Accessible.** Font scale up to 1.3 without clipping, a role and label on every control, WCAG
  AA contrast (also on glass), touch targets ≥ 44 pt (iOS) and ≥ 48 dp (Android). Keyboard and
  safe areas are handled on every form: no field hidden by the keyboard, no content under the
  notch or home indicator.
- **Senior code.** Small typed components, logic in hooks, no `any`, no dead or copy-pasted code,
  no magic numbers, no TODO without an issue, names from `docs/glossary.md`.

**Proof in every PR**

- Each changed screen is compared side by side with the design reference on the Android
  emulator. Every visible difference you can name is fixed: alignment, spacing, radius, weight,
  color.
- The PR shows the screenshots next to the reference and lists what the human must check on the
  iPhone (Liquid Glass renders only on iOS 26: a real iPhone or the Xcode 26 simulator; neither is
  available on this Windows machine, so the iPhone check is the human's).

The deck is a **look** reference only. Its copy and features never override the product rules.
That means no "guarantee", "insured", "upfront pricing" or escrow claims (legal copy rule), only
the 5 MVP categories, and only features that work today.
