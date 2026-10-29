import type { ApiSchema } from "@jack/shared";
import { queryOptions, useQuery, type QueryClient } from "@tanstack/react-query";
import { useFocusEffect } from "expo-router";
import { useCallback, useMemo } from "react";
import { AppState } from "react-native";

import { apiGet, ApiError } from "@/api";
import { evictOpportunity } from "@/features/pro-home/useOpportunities";
import { useExpiryClock } from "@/features/quotes/expiry";

export type OpportunityDetail = ApiSchema<"OpportunityDetail">;
export type OpportunityMedia = ApiSchema<"OpportunityMedia">;

export const opportunityQueryKey = (dispatchId: string) => ["opportunities", dispatchId] as const;

/**
 * One open opportunity as the pro sees it; the server marks it viewed on the first open. A
 * failure shows at once with a retry rather than behind a skeleton, and a 404 (not open for this
 * pro any more) never improves by asking again.
 */
export const opportunityQueryOptions = (dispatchId: string) =>
  queryOptions({
    queryKey: opportunityQueryKey(dispatchId),
    queryFn: ({ signal }) =>
      apiGet("/v1/pros/me/opportunities/{dispatch_id}", {
        auth: true,
        signal,
        params: { dispatch_id: dispatchId },
      }),
    retry: false,
  });

/** The opportunity; with `enabled` false nothing is asked for (a screen that already saw a 404). */
export const useOpportunity = (dispatchId: string, enabled = true) =>
  useQuery({ ...opportunityQueryOptions(dispatchId), enabled });

/** Not open for this pro: another pro's, declined, expired or quoted (404). */
export const isGone = (error: unknown): boolean =>
  error instanceof ApiError && error.status === 404;

/**
 * The pro may not see it any more (the detail answered 404): its row leaves the list, and its
 * detail, signed media URLs included, leaves the cache. A later failure cannot show the old
 * body again; only a new answer can.
 */
export function forgetOpportunity(client: QueryClient, dispatchId: string): void {
  evictOpportunity(client, dispatchId);
  client.removeQueries({ queryKey: opportunityQueryKey(dispatchId), exact: true });
}

/** Its signed URL is past `expires_at` at `now`: never shown, fetched again instead. */
export const mediaExpired = (media: OpportunityMedia, now: number): boolean =>
  Date.parse(media.expires_at) <= now;

const NO_EXPIRIES: readonly string[] = [];

/**
 * Keeps the media's short-lived URLs usable. Returns the time the tiles are drawn at, which
 * moves on exactly when a URL expires (`useExpiryClock`), and refetches the detail when an
 * expired URL is on a focused screen: on focus, on foreground, and the moment one expires while
 * shown. An answer whose URLs were already past when it arrived (`dataUpdatedAt`) is not asked
 * for again: the clocks disagree, and asking would loop.
 */
export function useRefreshExpiredMedia(
  media: readonly OpportunityMedia[] | undefined,
  dataUpdatedAt: number,
  refetch: () => Promise<unknown>,
): number {
  const expiresAts = useMemo(() => media?.map((item) => item.expires_at) ?? NO_EXPIRIES, [media]);
  const now = useExpiryClock(expiresAts);
  const expired = expiresAts.some((expiresAt) => Date.parse(expiresAt) <= now);
  const arrivedExpired = expiresAts.some((expiresAt) => Date.parse(expiresAt) <= dataUpdatedAt);

  const refresh = useCallback(() => {
    if (expired && !arrivedExpired) void refetch();
  }, [arrivedExpired, expired, refetch]);

  // Runs on each focus, and again whenever `refresh` changes while focused (a URL just expired).
  useFocusEffect(
    useCallback(() => {
      refresh();
      const subscription = AppState.addEventListener("change", (state) => {
        if (state === "active") refresh();
      });
      return () => subscription.remove();
    }, [refresh]),
  );

  return now;
}
