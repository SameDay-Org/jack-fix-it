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
- Welcome's panel (#148): the white bubble rises into Role or Login (`usePanelTransition`,
  `src/features/auth`): a UI-thread transform over `motion.panelRiseMs`, corners and color
  easing into the page, the hero dimming by `motion.panelHeroDim`. Welcome prefetches both
  routes at rest; pushed with `from: "welcome"`, they take `risenFromWelcome`'s options (Android:
  a transparent modal pushed as the rise starts, so Welcome keeps painting under it both ways;
  iOS: `fade`, pushed as it ends). `useContentTransition` hands off through `panelHandoff` (scoped to the `(auth)` layout by
  `PanelHandoffProvider`, so a sign-in takes it away and the next Welcome starts at rest): the
  screen fades in only once laid out, shown by the stack and the panel risen, mirrors the panel's
  status bar until then, focuses the title, and fades out before back (hardware back only while
  focused). Reduce Motion: a crossfade over Welcome.
- Routing (D5.3, #33): `src/app/(auth)` holds welcome, role, sign-up and login; `src/app/(app)`
  holds the signed-in screens. `SessionGate` (`src/features/auth`) is the one gate: `restoring`
  keeps the native splash, `restoreFailure: "offline"` shows the offline screen, and
  `Stack.Protected` guards send `signedIn` to `(app)` and everyone else to `(auth)/welcome`,
  deep links included. Routes stay thin: screens, form hooks and error mapping live in
  `src/features/auth`, and screen tests live there too (never under `src/app`).
- Phone verification (D5.3 OTP, #138): `src/app/(app)/verify-phone` (number, then `code`),
  screens and hooks in `src/features/phone`. A US number behind `EXPO_PUBLIC_PHONE_COUNTRY_CODE`,
  sent as E.164; the code in the kit's `CodeInput` (one-time-code autofill), auto-submitted at 6
  digits, resend after `EXPO_PUBLIC_OTP_RESEND_SECONDS`. The number travels in the flow store,
  never in a route. A sign-up lands on it with "Skip for now"; home offers it until verified.
- Launch intro (D18, #147): every start draws `LaunchIntro` (`src/features/launch`) over the
  gate: the navy hero with `WordRotator` (`src/components/ui`) rolling the headline's verb on
  the UI thread, width tweened so the sentence never jumps, one static screen-reader label, tap
  to skip, crossfade under Reduce Motion. It lifts the native splash (plain navy-900, set in
  `app.config.ts`, a dev-build change) when its first frame is final, runs for one word cycle
  (`motion.launchMinMs`) and never past `motion.launchMaxMs`; the gate shows the static hero
  while restoring. Timings are `motion.*` tokens.
- Liquid Glass: only through `GlassSurface` (`src/components/ui`): `tone` light | dark,
  `shape` pill | xl | lg, `interactive`. Native `GlassView` on iOS 26+ when
  `isLiquidGlassAvailable()` and Reduce Transparency is off (live, `useReduceTransparency`);
  otherwise a solid token surface with the same shape (opaque white with the bubble shadow, or
  solid navy-700); while the preference is still unknown it renders the solid surface too.
  Controls layer only, never content cards; ESLint rejects `expo-glass-effect` anywhere else
  (ADR 0008).
- Sheets: a route presented with `sheetOptions(detents)` from its Stack (`<Stack.Screen name="x"
options={sheetOptions([0.5, 0.95])} />`, or `"fitToContents"`), rendering `SheetContent`
  (title, body, actions; safe area and keyboard handled). With `"fitToContents"` the route also
  passes `fitToContents` to `SheetContent`: the sheet takes the content's height, and Android
  hides a fit-to-contents sheet whose root fills. Native form sheet: system glass on iOS 26+,
  same detents on Android. No sheet library.
- Toasts: `showToast({ message, tone })` from anywhere; one at a time, `motion.toastMs` long,
  rendered by the `ToastHost` the root layout mounts. Dismiss text is `common.dismiss`.
- Data: TanStack Query for server state, Zustand for small client state. API types come from
  `@jack/shared`.
- API layer (`src/api`, D5.4): the app reaches the API only through `apiGet(path)` and
  `apiPost(path, body)`, with `{ auth: true }` for signed-in requests. Paths are the OpenAPI keys
  from `@jack/shared`, never URLs; bodies and responses are typed from them. Errors are
  `ApiError(status, code)`, `NetworkError` (offline or past `EXPO_PUBLIC_API_TIMEOUT_MS`) and
  `SessionExpiredError`. The session (`useSession`, `login`, `register`, `logout`,
  `restoreSession`) keeps the refresh token in `expo-secure-store` and the access token in
  memory only, refreshes single-flight and retries a `401 invalid_token` once. Async auth work
  carries a session generation: a result from before a sign-in or sign-out is discarded
  (`SessionExpiredError` with reason `superseded`). A sign-out is a barrier: it clears memory
  and the Query cache before its first await, and auth work started while it is in flight is
  refused as `superseded`; a newer sign-in is not held by it. A sign-out that cannot delete the
  stored token rejects with `LocalCleanupError` and sets `cleanupPending`; restore retries the
  delete and never signs in from that entry. Cancelled callers send nothing, even after a shared
  refresh. Never log a token. ESLint rejects `fetch` and `expo-secure-store` outside `src/api`.
- Media (D6.2, #130): `useMediaUpload({ purpose })` (`src/features/media`) picks from the
  camera (photos only, after `requestCameraPermissionsAsync`; refused shows
  `MediaPermissionNotice` with "Open settings") or the system photo picker (no permission;
  videos only for `request_media`), prepares each file and uploads it, one at a time, keeping
  items with status, progress, key, retry and remove. `prepareMedia` always re-encodes images as
  JPEG (long edge `EXPO_PUBLIC_IMAGE_MAX_EDGE`, quality `EXPO_PUBLIC_IMAGE_QUALITY`), so EXIF and
  GPS never leave the phone; videos go as they are, checked against
  `EXPO_PUBLIC_UPLOAD_MAX_VIDEO_BYTES`. `uploadMedia` (`src/api/upload.ts`) asks
  `POST /v1/uploads` for a URL signed for the exact type and size, then PUTs the bytes (XHR, for
  progress) to exactly that URL with exactly its headers and never the bearer token. Bytes stay
  native: a photo is read as a native Blob, a video (size known from the picker) is sent as
  `{ uri }` (Android streams it from disk; iOS reads it into native memory first); never
  `fetch(uri).blob()`, which copies through base64 into JavaScript. Android upload progress is
  halved (RN 0.88 counts each byte twice; a tripwire test watches that source), and a JavaScript
  watchdog keeps the PUT deadline on both platforms; one retry on
  a network failure, with a fresh URL if it expired; `UploadRejectedError` (403/422) and
  `UploadFailedError` (storage refusal, network, or past `EXPO_PUBLIC_UPLOAD_TIMEOUT_MS` plus the
  file's time at `EXPO_PUBLIC_UPLOAD_MIN_BYTES_PER_SECOND`). `MediaPicker`
  renders the list and asks "Camera or library" in `MediaSourceSheet`, a sheet route in the
  caller's stack; `ProgressRing` (kit) draws progress without SVG. Dev demo: `jackfixit://dev/media`
  (signed-in customer). Local uploads need an
  S3-compatible server on the host; docker-compose has none, see the commands below.
- Strings: `src/i18n/locales/{en,es}.json` through `useTranslation()`; the device language
  picks the catalog, English is the fallback.
- Config: `app.config.ts` reads `APP_VARIANT` (development, preview, production) to suffix the
  name and bundle id. The EAS owner and project id are public constants there. The API URL is
  `EXPO_PUBLIC_API_URL` (https outside development), set per profile in `eas.json`; the request
  timeout is `EXPO_PUBLIC_API_TIMEOUT_MS`.
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
pnpm --filter @jack/mobile test        # jest-expo; jest.setup.ts warms RN's lazy components first (#140)
pnpm --filter @jack/mobile exec expo export --platform android --output-dir dist-ci   # bundle check

# Local uploads (#130): an S3-compatible server on the host and a bucket (any S3 client), then
# the API's untracked .env: S3_ENDPOINT_URL=http://10.0.2.2:9000 (the host as the emulator dials
# it; the URL is signed for that host), S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY,
# S3_REGION=us-east-1.
docker run -d -p 9000:9000 -e RUSTFS_ACCESS_KEY=<key> -e RUSTFS_SECRET_KEY=<secret> rustfs/rustfs
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
