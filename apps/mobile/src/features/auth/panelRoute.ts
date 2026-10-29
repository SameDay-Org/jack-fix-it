import { tokens } from "@/theme";

/** The stack options a panel rise gives the screen it opens (Role and Login, the request flow). */
export type PanelRouteOptions = {
  animation: "default" | "fade" | "none";
  presentation?: "transparentModal";
  contentStyle?: { backgroundColor: string };
};

/**
 * Whether the destination is pushed when the rise starts (and mounts under the rising panel) or
 * when it ends. Android pushes at the start; iOS at the end (see `panelRiseOptions`).
 */
export const pushesUnderRise = (platform: string): boolean => platform !== "ios";

/**
 * The stack options of a screen a panel rises into (Welcome's into Role or Login, Home's
 * categories into the request flow), by platform. The rise is the transition:
 *
 * - Android: a transparent modal with no stack animation, pushed as the rise starts. It mounts
 *   under the rising panel, see-through until the panel has settled; then its page (the panel's
 *   color) and its content fade in over it. react-native-screens keeps the screen under a
 *   transparent one attached, so the panel's screen keeps painting the covered panel through the way back
 *   too: an opaque push detached it, and the pop showed an empty frame before it reattached. (Its
 *   `fade` also dimmed the page: it fades the old screen out while the new one fades in.)
 * - iOS: `fade`, pushed when the rise ends. There it fades only the top screen over the one below,
 *   and the edge swipe back keeps driving the native pop; a transparent modal would have no swipe
 *   back. The card's own background is the panel's page color, so its fades never show another
 *   gray (the navigator's default) between the panel and the content.
 *
 * Under Reduce Motion the panel does not rise and the same options give a crossfade between the
 * two painted screens.
 */
export function panelRiseOptions(platform: string): PanelRouteOptions {
  return pushesUnderRise(platform)
    ? { animation: "none", presentation: "transparentModal" }
    : { animation: "fade", contentStyle: { backgroundColor: tokens.colors["gray-50"] } };
}

/**
 * Role's and Login's options: the panel rise when Welcome's panel pushed them (`from: "welcome"`);
 * reached any other way (a deep link, sign-up's "log in instead"), the platform's default push.
 */
export function risenFromWelcome(params: object | undefined, platform: string): PanelRouteOptions {
  if ((params as { from?: string } | undefined)?.from !== "welcome")
    return { animation: "default" };
  return panelRiseOptions(platform);
}
