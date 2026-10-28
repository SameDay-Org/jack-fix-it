import {
  infiniteQueryOptions,
  useInfiniteQuery,
  type InfiniteData,
  type QueryClient,
} from "@tanstack/react-query";

import { apiGet, ApiError, type GetResponse } from "@/api";

export type OpportunityPage = GetResponse<"/v1/pros/me/opportunities">;
export type OpportunitySummary = OpportunityPage["items"][number];
/** The cursor of a page: none for the first, the previous page's `next_cursor` after that. */
type Cursor = string | undefined;
// The page params are not read back, so their type is left open (as `useInfiniteQuery` yields it).
type OpportunityPages = InfiniteData<OpportunityPage, unknown>;

export const OPPORTUNITIES_QUERY_KEY = ["opportunities"] as const;
/** Rows per page (#219): the API's own default, asked for explicitly so the two never drift. */
export const OPPORTUNITY_PAGE_SIZE = 20;

const NOT_FOUND = "not_found";

/** The pro has no profile yet, so nothing was ever dispatched to it (`GET /v1/pros/me` creates it). */
const noProfile = (error: unknown): boolean =>
  error instanceof ApiError && error.status === 404 && error.code === NOT_FOUND;

const fetchPage = (cursor: string | undefined, signal: AbortSignal) =>
  apiGet("/v1/pros/me/opportunities", {
    auth: true,
    signal,
    query: { limit: OPPORTUNITY_PAGE_SIZE, cursor },
  });

/**
 * One page of the pro's open opportunities. A pro who never opened their profile has none yet
 * (404 `not_found`): the profile is created, once, and the page asked for again. If either call
 * fails, the error shows with a retry.
 */
async function fetchOpportunities(
  cursor: string | undefined,
  signal: AbortSignal,
): Promise<OpportunityPage> {
  try {
    return await fetchPage(cursor, signal);
  } catch (error) {
    if (!noProfile(error)) throw error;
    await apiGet("/v1/pros/me", { auth: true, signal });
    return fetchPage(cursor, signal);
  }
}

/**
 * The open opportunities, newest first as the API orders them, a page per `next_cursor`. A
 * failure shows at once with a retry rather than behind a skeleton.
 */
export const opportunitiesQueryOptions = () =>
  infiniteQueryOptions({
    queryKey: OPPORTUNITIES_QUERY_KEY,
    queryFn: ({ pageParam, signal }) => fetchOpportunities(pageParam, signal),
    initialPageParam: undefined as Cursor,
    getNextPageParam: (lastPage) => lastPage.next_cursor ?? undefined,
    retry: false,
  });

export const useOpportunities = () => useInfiniteQuery(opportunitiesQueryOptions());

/** The rows of every loaded page, in order. */
export const flattenOpportunities = (data: OpportunityPages | undefined): OpportunitySummary[] =>
  data?.pages.flatMap((page) => page.items) ?? [];

function updatePages(
  client: QueryClient,
  update: (items: OpportunitySummary[]) => OpportunitySummary[],
): void {
  client.setQueryData<OpportunityPages>(OPPORTUNITIES_QUERY_KEY, (data) =>
    data === undefined
      ? undefined
      : { ...data, pages: data.pages.map((page) => ({ ...page, items: update(page.items) })) },
  );
}

/** The pro opened it: its "New" marker goes away in the list behind the detail. */
export const markOpportunityViewed = (client: QueryClient, dispatchId: string): void =>
  updatePages(client, (items) =>
    items.map((item) =>
      item.dispatch_id === dispatchId && !item.viewed ? { ...item, viewed: true } : item,
    ),
  );

/** It is no longer open for this pro (the detail answered 404): gone from the list too. */
export const evictOpportunity = (client: QueryClient, dispatchId: string): void =>
  updatePages(client, (items) => items.filter((item) => item.dispatch_id !== dispatchId));
