import type { ApiSchema } from "@jack/shared";
import { queryOptions, useQuery } from "@tanstack/react-query";
import { useFocusEffect } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { AppState } from "react-native";

import { apiGet, ApiError } from "@/api";

export type CustomerQuote = ApiSchema<"CustomerQuote">;
export type CustomerQuoteList = ApiSchema<"CustomerQuoteList">;

export const quotesQueryKey = (requestId: string) => ["requests", requestId, "quotes"] as const;

/**
 * The accepted quote on top (#190 AC4), every other one where the API put it. The API orders the
 * whole list cheapest first, the accepted quote included (#188); nothing else is re-sorted.
 */
export const acceptedFirst = (list: CustomerQuoteList): CustomerQuoteList => ({
  items: [
    ...list.items.filter((quote) => quote.status === "accepted"),
    ...list.items.filter((quote) => quote.status !== "accepted"),
  ],
});

/**
 * The quotes on one of the customer's requests: the accepted one first, then the others in the
 * API's order (cheapest first). The cache keeps the API's answer as it came. A failure shows at
 * once with a retry rather than behind a skeleton, and a 404 never improves by asking again.
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
    select: acceptedFirst,
    retry: false,
  });

export const useRequestQuotes = (requestId: string) => useQuery(quotesQueryOptions(requestId));

/** Not the caller's request (404), or not a customer (403): asking again shows the same. */
export const isNotFound = (error: unknown): boolean =>
  error instanceof ApiError && (error.status === 404 || error.status === 403);

/**
 * The error the list last settled on. A fetch that starts on a query without data resets `error`
 * to null (TanStack's `fetchState`), so while a retry or a refetch runs this keeps the previous
 * one on screen instead of falling back to the skeletons; data clears it.
 */
export function useSettledError(data: unknown, error: unknown): unknown {
  const [settled, setSettled] = useState<unknown>(null);

  // Adjusted while rendering (React's pattern for state derived from the previous render), so
  // no frame ever shows the skeletons between two errors.
  if (error && error !== settled) setSettled(error);
  else if (!error && data !== undefined && settled !== null) setSettled(null);

  return data === undefined ? (error ?? settled) : error;
}

/**
 * Refetches whenever the screen comes back into focus (a sheet over it closed, a pushed screen
 * went back) and whenever the app returns to the foreground while it is focused: new quotes
 * arrive while the customer is away. The first focus is the mount, which already fetched. With
 * `enabled` false (a request that is not found) it does nothing: the answer would not change.
 */
export function useRefetchOnReturn(refetch: () => Promise<unknown>, enabled = true): void {
  const mounted = useRef(false);
  const active = useRef(enabled);

  useEffect(() => {
    active.current = enabled;
  }, [enabled]);

  useFocusEffect(
    useCallback(() => {
      if (mounted.current && active.current) void refetch();
      mounted.current = true;
      const subscription = AppState.addEventListener("change", (state) => {
        if (state === "active" && active.current) void refetch();
      });
      return () => subscription.remove();
    }, [refetch]),
  );
}
