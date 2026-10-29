import type { NavigationProp, ParamListBase } from "expo-router/react-navigation";
import { useLocalSearchParams, useNavigation } from "expo-router";
import { useEffect } from "react";

import { isUuid, profileHref, useGuardedPush } from "./navigation";

// The app's own scheme (`scheme` in app.config.ts): a native build hands the whole URL over, and
// what follows `://` is the path, its first segment included.
const APP_SCHEME = "jackfixit://";
// Expo Go: its host, then the path after `/--/`.
const EXPO_GO = /^exps?:\/\/[^/?#]*\/--\//;

/**
 * The path of a link the app routes, after its prefix (kept as it came): the app's scheme, Expo
 * Go's host and `/--/`, or the leading slash. Null for anything else, `https://host/…` included:
 * the app has no web links, and a host is never read as a path segment.
 */
function splitPrefix(url: string): { prefix: string; rest: string } | null {
  const expoGo = EXPO_GO.exec(url)?.[0];
  const prefix = url.startsWith(APP_SCHEME)
    ? APP_SCHEME
    : (expoGo ?? (url.startsWith("/") && !url.startsWith("//") ? "/" : null));
  return prefix === null ? null : { prefix, rest: url.slice(prefix.length) };
}

/**
 * The request and quote of a link to a pro's profile: exactly `requests/<uuid>/quotes/<uuid>/pro`
 * (a trailing slash, a query or a fragment allowed), each id a UUID after one decode. Null for
 * anything else: another path, an extra segment, a delimiter or a dot segment in an id, a double
 * encoding, a malformed escape (which throws).
 */
function profileLink(rest: string): { requestId: string; quoteId: string } | null {
  const end = rest.search(/[?#]/);
  const segments = (end === -1 ? rest : rest.slice(0, end)).split("/");
  if (segments.length === 6 && segments[5] === "") segments.pop();
  if (segments.length !== 5) return null;
  const [requests, rawRequestId, quotes, rawQuoteId, pro] = segments;
  if (requests !== "requests" || quotes !== "quotes" || pro !== "pro") return null;
  const requestId = decodeURIComponent(rawRequestId);
  const quoteId = decodeURIComponent(rawQuoteId);
  return isUuid(requestId) && isUuid(quoteId) ? { requestId, quoteId } : null;
}

/**
 * Where a link that reaches the running app lands (`+native-intent`). Expo Router applies a
 * layout's anchor to the app's initial URL only, so a link to a pro's profile would open it over
 * whatever is on screen, with no comparison under it: Back would leave the request. The link
 * lands on the comparison with `profile=<quoteId>` instead, and the comparison opens the profile
 * over itself (`useProfileFromLink`), the same stack a card's tap builds. The initial URL keeps
 * the anchor and passes through, like every other input, exactly as it came. Never throws: a
 * throw here would drop the link.
 */
export function redirectSystemPath({ path, initial }: { path: string; initial: boolean }): string {
  if (initial) return path;
  try {
    const split = splitPrefix(path);
    const link = split && profileLink(split.rest);
    if (!split || !link) return path;
    const requestId = encodeURIComponent(link.requestId);
    return `${split.prefix}requests/${requestId}?profile=${encodeURIComponent(link.quoteId)}`;
  } catch {
    return path;
  }
}

/**
 * Opens the pro's profile over the comparison when a link asked for it (`?profile=<quoteId>`,
 * see `redirectSystemPath`): once per link. The param is cleared on this screen's own route
 * (`router.setParams` would set it on the root's) as the push goes out, so a later mount of the
 * comparison (back from the profile, a session change) opens nothing again. Anyone can write
 * such a link, so only one `profile` that is a UUID, on a request id that is one, opens
 * anything; any other value (repeated, empty, a dot segment, an escape) is cleared and opens
 * nothing.
 */
export function useProfileFromLink(requestId: string): void {
  const { profile } = useLocalSearchParams<{ profile?: string | string[] }>();
  const navigation = useNavigation<NavigationProp<ParamListBase>>();
  const push = useGuardedPush();

  useEffect(() => {
    if (profile === undefined) return;
    navigation.setParams({ profile: undefined });
    if (isUuid(profile) && isUuid(requestId)) push(profileHref(requestId, profile));
  }, [navigation, push, requestId, profile]);
}
