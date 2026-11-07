import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { router, usePathname } from "expo-router";
import { useEffect, useLayoutEffect, useRef, useSyncExternalStore } from "react";

import { ApiError, isCurrentGeneration, useSession, type SessionUser } from "@/api";

import { HOME_PUSH_PATH, parsePushLink, pushRoute } from "./deepLinks";
import { peekPushTap, subscribePushTaps, takePushTap, type PendingPushTap } from "./pushTaps";

// The newest tap being opened: an older one still waiting for the API opens nothing.
let latest = 0;

/** The API refused the session on the device: not this account's request, job or dispatch. */
const isRefused = (error: unknown): boolean =>
  error instanceof ApiError && (error.status === 403 || error.status === 404);

/**
 * Opens one tapped push for the signed-in account of `role`. A path outside the allow-list, one
 * no screen opens yet, or one for the other role opens nothing, silently: the app stays where it
 * is, which after a cold start is Home. Nothing goes back to Home from a screen that is already
 * up: a request or a quote being written there would ask to be discarded for a push that opens
 * nothing. An allowed path is asked of the API first, with this session: a refusal (another
 * account's push) opens nothing either; any other failure (offline, a server error) still opens
 * the screen, which shows its own error and retry, and the API refuses it the data all the same.
 * Nothing opens once the session the push was tapped in is gone, or a newer tap came in
 * meanwhile. A screen already on top for that path stays as it is (the answer refreshed what it
 * shows); any other opens over the current one, so Back returns there. Home (`/`, #338) is the
 * signed-in account's own, so nothing is asked: the app goes back to it like its other "back to
 * Home" actions, and a screen holding a draft asks first.
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
  if (link?.path === HOME_PUSH_PATH) {
    if (currentPath() !== HOME_PUSH_PATH) router.dismissTo(HOME_PUSH_PATH);
    return;
  }
  const route = pushRoute(link, role);
  if (link === null || route === null) return;
  try {
    await route.probe(client, link.id, tap.generation);
  } catch (error) {
    if (isRefused(error)) return;
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
