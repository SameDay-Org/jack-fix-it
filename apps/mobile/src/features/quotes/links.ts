import { router, useLocalSearchParams } from "expo-router";
import { useEffect } from "react";

import { profileHref, useGuardedPush } from "./navigation";

// A link to a pro's profile. What precedes the path is kept as it came: the app's scheme on a
// native build (`jackfixit://requests/…`), Expo Go's host and `/--/`, or the leading slash.
const PROFILE_LINK =
  /^((?:[a-z][a-z0-9+.-]*:\/\/(?:[^/]*\/--\/)?)|\/)requests\/([^/?#]+)\/quotes\/([^/?#]+)\/pro\/?(?:[?#].*)?$/;

/**
 * Where a link that reaches the running app lands (`+native-intent`). Expo Router applies a
 * layout's anchor to the app's initial URL only, so a link to a pro's profile would open it over
 * whatever is on screen, with no comparison under it: Back would leave the request. The link
 * lands on the comparison with `profile=<quoteId>` instead, and the comparison opens the profile
 * over itself (`useProfileFromLink`), the same stack a card's tap builds. The initial URL keeps
 * the anchor and passes through, like every other path.
 */
export function redirectSystemPath({ path, initial }: { path: string; initial: boolean }): string {
  if (initial) return path;
  const match = PROFILE_LINK.exec(path);
  if (!match) return path;
  const [, prefix, requestId, quoteId] = match;
  return `${prefix}requests/${requestId}?profile=${quoteId}`;
}

/**
 * Opens the pro's profile over the comparison when a link asked for it (`?profile=<quoteId>`,
 * see `redirectSystemPath`): once per link. The param is cleared as the push goes out, so a
 * later mount of the comparison (back from the profile, a session change) opens nothing again.
 */
export function useProfileFromLink(requestId: string): void {
  const { profile } = useLocalSearchParams<{ profile?: string }>();
  const push = useGuardedPush();

  useEffect(() => {
    if (!profile) return;
    router.setParams({ profile: undefined });
    push(profileHref(requestId, profile));
  }, [push, requestId, profile]);
}
