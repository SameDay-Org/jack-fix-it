import { useQueryClient, type QueryKey } from "@tanstack/react-query";
import { useCallback, useEffect, useRef } from "react";

/**
 * Asks for the next page of the infinite list at `queryKey` without ever cancelling a refresh of
 * it (focus, pull, an invalidation): TanStack would drop the refresh and the old statuses would
 * stay on screen. A page asked for during a refresh is fetched once the refresh settles. The query
 * is read directly, since a refresh that just started may not have rendered yet. Pass a stable key
 * (a constant, or one memoized on what it is built from).
 */
export function useNextPageAfterRefresh(
  queryKey: QueryKey,
  fetchNextPage: (options: { cancelRefetch: boolean }) => Promise<unknown>,
): () => void {
  const client = useQueryClient();
  const waiting = useRef<(() => void) | null>(null);
  useEffect(() => () => waiting.current?.(), []);

  return useCallback(() => {
    const cache = client.getQueryCache();
    const query = cache.find({ queryKey, exact: true });
    const fetch = () => void fetchNextPage({ cancelRefetch: false });
    if (query?.state.fetchStatus !== "fetching") return fetch();
    // A page on its way already, or one waiting for the refresh: nothing more to ask.
    if (query.state.fetchMeta?.fetchMore || waiting.current) return;
    const stop = cache.subscribe((event) => {
      if (event.query !== query) return;
      const removed = event.type === "removed";
      if (!removed && query.state.fetchStatus === "fetching") return;
      stop();
      waiting.current = null;
      if (!removed) fetch();
    });
    waiting.current = stop;
  }, [client, fetchNextPage, queryKey]);
}
