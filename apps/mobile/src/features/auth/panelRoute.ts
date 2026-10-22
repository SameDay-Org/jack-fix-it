/** The stack options the panel rise uses for Role and Login. */
export type PanelRouteOptions = {
  animation: "default" | "fade" | "none";
  presentation?: "transparentModal";
};

/**
 * Whether the destination is pushed when the rise starts (and mounts under the rising panel) or
 * when it ends. Android pushes at the start; iOS at the end (see `risenFromWelcome`).
 */
export const pushesUnderRise = (platform: string): boolean => platform !== "ios";

/**
 * The stack options for Role or Login, from the route's params and the platform. Pushed by
 * Welcome's panel (`from: "welcome"`), the rise is the transition:
 *
 * - Android: a transparent modal with no stack animation, pushed as the rise starts. It mounts
 *   under the rising panel, see-through until the panel has settled; then its page (the panel's
 *   color) and its content fade in over it. react-native-screens keeps the screen under a
 *   transparent one attached, so Welcome keeps painting the covered panel through the way back
 *   too: an opaque push detached it, and the pop showed an empty frame before it reattached. (Its
 *   `fade` also dimmed the page: it fades the old screen out while the new one fades in.)
 * - iOS: `fade`, pushed when the rise ends (the route prefetched as it starts). There it fades only
 *   the top screen over the one below, and the edge swipe back keeps driving the native pop; a
 *   transparent modal would have no swipe back.
 *
 * Under Reduce Motion Welcome does not rise and the same options give a crossfade between the two
 * painted screens. Reached any other way (a deep link, sign-up's "log in instead"), the platform's
 * default push.
 */
export function risenFromWelcome(params: object | undefined, platform: string): PanelRouteOptions {
  if ((params as { from?: string } | undefined)?.from !== "welcome")
    return { animation: "default" };
  return pushesUnderRise(platform)
    ? { animation: "none", presentation: "transparentModal" }
    : { animation: "fade" };
}
