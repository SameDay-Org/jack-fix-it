import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { router, usePathname } from "expo-router";
import { useEffect, useLayoutEffect, useRef, useSyncExternalStore } from "react";

import { ApiError, isCurrentGeneration, useSession, type SessionUser } from "@/api";

import { parsePushLink, pushRoute } from "./deepLinks";
import { peekPushTap, subscribePushTaps, takePushTap, type PendingPushTap } from "./pushTaps";

// The newest tap being opened: an older one still waiting for the API opens nothing.
let latest = 0;

/** The API refused the session on the device: not this account's request, job or dispatch. */
const isRefused = (error: unknown): boolean =>
  error instanceof ApiError && (error.status === 403 || error.status === 404);

const goHome = (): void => router.dismissTo("/");

/**
 * Opens one tapped push for the signed-in account of `role`. A path outside the allow-list, one
 * no screen opens yet, or one for the other role goes Home, silently. An allowed path is asked of
 * the API first, with this session: a refusal (another account's push) goes Home too; any other
 * failure (offline, a server error) still opens the screen, which shows its own error and retry,
 * and the API refuses it the data all the same. Nothing opens once the session the push was
 * tapped in is gone, or a newer tap came in meanwhile. A screen already on top for that path stays
 * as it is (the answer refreshed what it shows); any other opens over the current one, so Back
 * returns there.
 */
export async function openPushTap(
  tap: PendingPushTap,
  role: SessionUser["role"],
  client: QueryClient,
  currentPath: () => string,
): Promise<void> {
  const ticket = ++latest;
  const wanted = () => ticket === latest && isCurrentGeneration(tap.generation);
  if (!wanted()) return;
  const link = parsePushLink(tap.url);
  const route = pushRoute(link, role);
  if (link === null || route === null) {
    goHome();
    return;
  }
  try {
    await route.probe(client, link.id, tap.generation);
  } catch (error) {
    if (!wanted()) return;
    if (isRefused(error)) {
      goHome();
      return;
    }
  }
  // An allowed path is the screen's own pathname: `/jobs/<id>` opens `/jobs/[id]`.
  if (wanted() && currentPath() !== tap.url) router.push(route.href(link.id));
}

/**
 * Opens tapped pushes while the signed-in app is up (mounted by the `(app)` layout, so the router
 * holds the app's screens and the session is known); a tap from before (a cold start, a restore,
 * an account still on its sign-up flow) waits for it.
 */
export function useOpenPushTaps(): void {
  const client = useQueryClient();
  const { user } = useSession();
  const tap = useSyncExternalStore(subscribePushTaps, peekPushTap, peekPushTap);
  const role = user?.role;
  // Read when the API has answered, not when the tap came in.
  const current = usePathname();
  const pathname = useRef(current);
  useLayoutEffect(() => {
    pathname.current = current;
  }, [current]);

  useEffect(() => {
    if (tap === null || role === undefined) return;
    const taken = takePushTap();
    if (taken !== null) void openPushTap(taken, role, client, () => pathname.current);
  }, [client, role, tap]);
}
