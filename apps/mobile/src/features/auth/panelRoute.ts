/** The stack animations the panel rise uses for Role and Login. */
export type PanelRouteAnimation = "default" | "fade" | "none";

/**
 * The stack animation for Role or Login, from the route's params, the platform and Reduce Motion.
 * Pushed by Welcome's panel (`from: "welcome"`), the rise is the transition, so the route must
 * appear exactly where the panel ended, on the same page color:
 *
 * - Android: `none`. react-native-screens' Android `fade` fades the old screen out while the new
 *   one fades in, so the window shows through both halfway and the page dimmed mid-push on the
 *   device. The destination fades its own content in, and out before the pop.
 * - iOS: `fade`. There it fades only the top screen over the one below, and the edge swipe back
 *   keeps driving the native pop.
 * - Reduce Motion: `fade` on both. Welcome does not rise, so the stack's crossfade from the navy
 *   hero to the destination's page is the whole transition.
 *
 * Reached any other way (a deep link, sign-up's "log in instead"), the platform's default push.
 */
export function risenFromWelcome(
  params: object | undefined,
  platform: string,
  reduceMotion: boolean,
): PanelRouteAnimation {
  if ((params as { from?: string } | undefined)?.from !== "welcome") return "default";
  return reduceMotion || platform === "ios" ? "fade" : "none";
}
