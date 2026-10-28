import { router, useLocalSearchParams } from "expo-router";
import { useEffect } from "react";

import { profileHref } from "./navigation";

// A link to a pro's profile, with whatever precedes the path (a scheme on a native build, a
// leading slash otherwise) kept as it came.
const PROFILE_LINK = /^(.*?\/?)requests\/([^/?#]+)\/quotes\/([^/?#]+)\/pro\/?(?:[?#].*)?$/;

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
 * see `redirectSystemPath`): once per link, as the screen mounts or when a later link changes
 * the quote.
 */
export function useProfileFromLink(requestId: string): void {
  const { profile } = useLocalSearchParams<{ profile?: string }>();

  useEffect(() => {
    if (profile) router.push(profileHref(requestId, profile));
  }, [requestId, profile]);
}
