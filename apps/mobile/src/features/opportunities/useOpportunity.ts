import type { ApiSchema } from "@jack/shared";
import { queryOptions, useQuery, type QueryClient } from "@tanstack/react-query";
import { useFocusEffect } from "expo-router";
import { useCallback, useMemo } from "react";
import { AppState } from "react-native";

import { apiGet, ApiError } from "@/api";
import {
  allowOpportunity,
  denyOpportunity,
  evictOpportunity,
  flattenOpportunities,
  OPPORTUNITIES_QUERY_KEY,
} from "@/features/pro-home/useOpportunities";
import { useExpiryClock } from "@/features/quotes/expiry";

export type OpportunityDetail = ApiSchema<"OpportunityDetail">;
export type OpportunityMedia = ApiSchema<"OpportunityMedia">;

export const opportunityQueryKey = (dispatchId: string) => ["opportunities", dispatchId] as const;

/** Not open for this pro: another pro's, declined, expired or quoted (404). */
export const isGone = (error: unknown): boolean =>
  error instanceof ApiError && error.status === 404;

/**
 * One open opportunity as the pro sees it; the server marks it viewed on the first open. A
 * failure shows at once with a retry rather than behind a skeleton, and a 404 (not open for this
 * pro any more) never improves by asking again. The answer itself records a 404 as a denial and
 * a 200 lifts it, so a screen learns of a 404 even when a later answer replaced it before the
 * screen drew again.
 */
export const opportunityQueryOptions = (dispatchId: string) =>
  queryOptions({
    queryKey: opportunityQueryKey(dispatchId),
    queryFn: async ({ signal, client }) => {
      try {
        const detail = await apiGet("/v1/pros/me/opportunities/{dispatch_id}", {
          auth: true,
          signal,
          params: { dispatch_id: dispatchId },
        });
        allowOpportunity(client, dispatchId);
        return detail;
      } catch (error) {
        // A cancelled read (a sign-out cleared the cache) belongs to a session that is gone: its
        // 404 must not deny the dispatch to whoever is signed in now.
        if (isGone(error) && !signal.aborted) denyOpportunity(client, dispatchId);
        throw error;
      }
    },
    retry: false,
  });

/** The opportunity; with `enabled` false nothing is asked for (a screen that already saw a 404). */
export const useOpportunity = (dispatchId: string, enabled = true) =>
  useQuery({ ...opportunityQueryOptions(dispatchId), enabled });

/**
 * The pro may not see it any more (the detail answered 404): no page shows it from now on, its
 * row leaves the cached pages, and its detail, signed media URLs included, leaves the cache. A
 * later failure cannot show the old body again; only a new 200 can.
 *
 * A page fetch in flight holds the old pages and would write the row back when it lands, so
 * while the row is cached that fetch is cancelled first. The cancel restores the state from
 * before it (a failed next page stays failed, with its retry), so the row goes after it. With no
 * such row (a first load, or a request opened from a push) the fetch is left to land: the denial
 * hides the row in any answer.
 */
export async function forgetOpportunity(client: QueryClient, dispatchId: string): Promise<void> {
  denyOpportunity(client, dispatchId);
  const cached = flattenOpportunities(client.getQueryData(OPPORTUNITIES_QUERY_KEY));
  if (cached.some((item) => item.dispatch_id === dispatchId)) {
    await client.cancelQueries({ queryKey: OPPORTUNITIES_QUERY_KEY, exact: true });
  }
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
