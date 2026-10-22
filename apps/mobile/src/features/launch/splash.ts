import * as SplashScreen from "expo-splash-screen";

let lifted = false;

/**
 * Releases the native splash, once. Every path out of the launch intro calls it (first final
 * frame, exit, skip, unmount) and the root keeps a guard that calls it at `launchMaxMs` at the
 * latest, so no ordering of restore, Reduce Motion and measurement can leave the splash up.
 */
export function liftSplash(): void {
  if (lifted) return;
  lifted = true;
  void SplashScreen.hideAsync();
}

/** Tests only: a fresh app start. */
export function resetSplashForTests(): void {
  lifted = false;
}
