import {
  infiniteQueryOptions,
  useInfiniteQuery,
  type InfiniteData,
  type QueryClient,
} from "@tanstack/react-query";

import { apiGet, type GetResponse } from "@/api";

export type RequestPage = GetResponse<"/v1/requests">;
export type RequestSummary = RequestPage["items"][number];
/** The cursor of a page: none for the first, the previous page's `next_cursor` after that. */
type Cursor = string | undefined;
// The page params are not read back, so their type is left open (as `useInfiniteQuery` yields it).
type RequestPages = InfiniteData<RequestPage, unknown>;

// Not under "requests": that prefix holds each request's quotes, which a list refresh must not touch.
export const MY_REQUESTS_QUERY_KEY = ["my-requests"] as const;
/** Rows per page (#47): the API's own default, asked for explicitly so the two never drift. */
export const MY_REQUESTS_PAGE_SIZE = 20;

/**
 * The customer's requests, newest first as the API orders them, a page per `next_cursor`. A
 * failure shows at once with a retry rather than behind a skeleton.
 */
export const myRequestsQueryOptions = () =>
  infiniteQueryOptions({
    queryKey: MY_REQUESTS_QUERY_KEY,
    queryFn: ({ pageParam, signal }) =>
      apiGet("/v1/requests", {
        auth: true,
        signal,
        query: { limit: MY_REQUESTS_PAGE_SIZE, cursor: pageParam },
      }),
    initialPageParam: undefined as Cursor,
    getNextPageParam: (lastPage) => lastPage.next_cursor ?? undefined,
    retry: false,
  });

export const useMyRequests = () => useInfiniteQuery(myRequestsQueryOptions());

/**
 * The rows of every loaded page, in order, each request once. The API's keyset cursor never repeats
 * a row; this keeps the list's keys unique even if a page boundary ever did. The first copy stays.
 */
export function flattenMyRequests(data: RequestPages | undefined): RequestSummary[] {
  const seen = new Set<string>();
  const rows: RequestSummary[] = [];
  for (const item of data?.pages.flatMap((page) => page.items) ?? []) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    rows.push(item);
  }
  return rows;
}

/**
 * The list is out of date (a request was sent, a quote accepted): refetched now if History is
 * mounted, on its next mount otherwise. Not awaited by callers: the list is not theirs to wait on.
 */
export const invalidateMyRequests = (client: QueryClient): Promise<void> =>
  client.invalidateQueries({ queryKey: MY_REQUESTS_QUERY_KEY });
