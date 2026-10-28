import type { ApiSchema } from "@jack/shared";
import { queryOptions, useQuery } from "@tanstack/react-query";
import { useFocusEffect } from "expo-router";
import { useCallback, useRef } from "react";
import { AppState } from "react-native";

import { apiGet, ApiError } from "@/api";

export type CustomerQuote = ApiSchema<"CustomerQuote">;
export type CustomerQuoteList = ApiSchema<"CustomerQuoteList">;

export const quotesQueryKey = (requestId: string) => ["requests", requestId, "quotes"] as const;

/**
 * The quotes on one of the customer's requests, in the API's order: the accepted one first, then
 * the pending ones, cheapest first. A failure shows at once with a retry rather than behind a
 * skeleton, and a 404 never improves by asking again.
 */
export const quotesQueryOptions = (requestId: string) =>
  queryOptions({
    queryKey: quotesQueryKey(requestId),
    queryFn: ({ signal }) =>
      apiGet("/v1/requests/{request_id}/quotes", {
        auth: true,
        signal,
        params: { request_id: requestId },
      }),
    retry: false,
  });

export const useRequestQuotes = (requestId: string) => useQuery(quotesQueryOptions(requestId));

/** Not the caller's request (404), or not a customer (403): asking again shows the same. */
export const isNotFound = (error: unknown): boolean =>
  error instanceof ApiError && (error.status === 404 || error.status === 403);

/**
 * Refetches whenever the screen comes back into focus (a sheet over it closed, a pushed screen
 * went back) and whenever the app returns to the foreground while it is focused: new quotes
 * arrive while the customer is away. The first focus is the mount, which already fetched.
 */
export function useRefetchOnReturn(refetch: () => Promise<unknown>): void {
  const mounted = useRef(false);

  useFocusEffect(
    useCallback(() => {
      if (mounted.current) void refetch();
      mounted.current = true;
      const subscription = AppState.addEventListener("change", (state) => {
        if (state === "active") void refetch();
      });
      return () => subscription.remove();
    }, [refetch]),
  );
}
