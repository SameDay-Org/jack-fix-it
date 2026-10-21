# 0008. Mobile visual language: deck look, Liquid Glass on the controls layer only

- **Status:** accepted
- **Date:** 2026-10-20

On Cesar's instruction (2026-10-20), the mobile app takes the look of the partner deck: lime
green on deep navy, white rounded "bubble" surfaces and bold headlines, under the name Jack Fix
It. This changes a closed decision, the brand palette (navy + orange, context doc §11); the
palette, shapes and type are in `docs/design/README.md`. On iPhone the app also uses real
Liquid Glass (iOS 26+). Glass everywhere would hurt legibility and performance and blur the
content hierarchy, so its use is bounded:

- **(a) Where.** Liquid Glass only on the navigation and controls layer: tab bar, top bars,
  sheets, floating buttons, toasts. Never on content cards, which stay solid white bubbles.
- **(b) iOS 26+.**
  - Native glass through `expo-glass-effect` (`GlassView`, `GlassContainer`,
    `isLiquidGlassAvailable()`), not a blur imitation.
  - The system tab bar through Expo Router native tabs.
  - Native sheet presentation (`formSheet` with detents), which gets glass from the system.
- **(c) Fallback.**
  - Android, iOS < 26 and Reduce Transparency get solid or near-solid surfaces with the same
    shapes. The app checks `isLiquidGlassAvailable()` and the Reduce Transparency setting at
    runtime instead of assuming.
  - Android keeps Material ripple and predictive back.
  - No full-screen blur over scrolling content on Android (performance).
- **(d) Contrast.** Text on glass meets WCAG AA (≥ 4.5:1) over any content that can scroll
  under it; if it cannot, the surface falls back to near-solid.
- **(e) Builds and verification.** New native modules (`expo-glass-effect`) require a new dev
  build (Android emulator and iPhone). No agent in this pipeline can render iOS (Windows host,
  shared Android emulator), so the final verification of glass happens on a real iPhone running
  iOS 26; the Android emulator proves the fallback only.

## Consequences

- #114 implements it in `apps/mobile`: theme tokens, the component kit, the glass primitive and
  `apps/mobile/AGENTS.md`. The web palette follows in #110.
- The font choice is still pending #18 (final design system) and #30.
- Every mobile PR lists what the human must check on the iPhone, since no agent can see glass.
- Reviewers block glass on content cards and text on glass below AA.

## Considered options

- **Keep navy + orange.** Replaced on Cesar's instruction (2026-10-20) by the deck's look.
- **Glass imitation with a blur view on every platform.** Rejected: it is not the system
  material, costs frames on Android and does not follow Reduce Transparency.
