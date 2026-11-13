import { type Href, unstable_useIsNavigating, useRouter } from "expo-router";
import { useCallback, useEffect, useRef } from "react";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * An id as the API writes it (a lowercase UUID). An id from outside the app (a link's path or
 * query) is checked with it before it reaches a route or a fetch.
 */
export const isUuid = (value: unknown): value is string =>
  typeof value === "string" && UUID.test(value);

/** The confirmation sheet for one quote, over whatever screen opens it. */
export const acceptHref = (requestId: string, quoteId: string): Href => ({
  pathname: "/requests/[id]/accept",
  params: { id: requestId, quote: quoteId },
});

/** The public profile of the pro behind one quote, pushed inside the request's stack. */
export const profileHref = (requestId: string, quoteId: string): Href => ({
  pathname: "/requests/[id]/quotes/[quoteId]/pro",
  params: { id: requestId, quoteId },
});

/**
 * One push per transition. The router queues a push and the screen stays tappable until it
 * lands, so a second tap (on the same control or another one) before then pushes nothing; once
 * the router is idle again (the screen is up, or the push came to nothing) the next tap works.
 *
 * The push goes through this screen's own router (`useRouter`), not the module-level `router`.
 * Expo Router points that one at the root that mounted last and unbinds it whenever a root
 * unmounts, and Android re-creates the app on a system font-size change: the new root mounts
 * while the old one is torn down, so the shared `router` throws for a moment, or for good if the
 * old root goes after the new one bound it (#344).
 */
export function useGuardedPush(): (href: Href) => void {
  const router = useRouter();
  const opening = useRef(false);
  const navigating = unstable_useIsNavigating();

  useEffect(() => {
    if (!navigating) opening.current = false;
  }, [navigating]);

  return useCallback(
    (href: Href) => {
      if (opening.current) return;
      opening.current = true;
      router.push(href);
    },
    [router],
  );
}
