import type * as PhoneSceneModule from "./phone-scene";

/**
 * The 3D phone's two-step loading (#403 PR 2, Foreman's decision of 2026-11-16).
 *
 * hero-motion.tsx imports this module with a dynamic import once the page has loaded and the
 * browser is idle. That downloads the 3D chunk (this module, phone-scene.ts and three.js) and
 * registers its modules, but evaluates only this tiny file: three.js is reached through the
 * `require` below, inside a function, so it is evaluated only when the reader shows intent
 * (scrolls, taps, presses a key) and the hero calls `phoneSceneModule()`. Evaluating three.js
 * and setting up WebGL is the expensive part on a phone's CPU; doing it on intent keeps it out
 * of the page's own loading.
 */
export function phoneSceneModule(): typeof PhoneSceneModule {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- a synchronous require inside a function is what keeps three.js in this chunk yet unevaluated until intent; an import statement would evaluate it with this module
  return require("./phone-scene") as typeof PhoneSceneModule;
}
