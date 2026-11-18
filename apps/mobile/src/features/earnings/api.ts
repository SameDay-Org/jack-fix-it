import {
  infiniteQueryOptions,
  useInfiniteQuery,
  useQueryClient,
  type InfiniteData,
} from "@tanstack/react-query";
import { useCallback } from "react";

import {
  ApiError,
  apiGet,
  NetworkError,
  useSession,
  useSessionGeneration,
  type GetResponse,
} from "@/api";

/** A page of the pro's earnings (GET /v1/pros/me/earnings, #70). */
export type EarningsPage = GetResponse<"/v1/pros/me/earnings">;
/** The totals over all the pro's jobs, not just the loaded pages. */
export type EarningsSummary = EarningsPage["summary"];
export type Earning = EarningsPage["items"][number];
/** `awaiting_confirmation`, `on_the_way`, `on_hold` or `paid`. */
export type EarningStatus = Earning["status"];

/** The cursor of a page: none for the first, the previous page's `next_cursor` after that. */
type Cursor = string | undefined;
type EarningsPages = InfiniteData<EarningsPage, unknown>;

/** Rows per page: the API's own default, asked for explicitly so the two never drift. */
export const EARNINGS_PAGE_SIZE = 20;

/** The pro's money as the session that asked for it sees it: the generation pins every call. */
export const earningsQueryKey = (generation: number) => ["pro-earnings", generation] as const;

export const earningsQueryOptions = (generation: number) =>
  infiniteQueryOptions({
    queryKey: earningsQueryKey(generation),
    queryFn: ({ pageParam, signal }): Promise<EarningsPage> =>
      apiGet("/v1/pros/me/earnings", {
        auth: true,
        signal,
        generation,
        query: { cursor: pageParam, limit: EARNINGS_PAGE_SIZE },
      }),
    initialPageParam: undefined as Cursor,
    getNextPageParam: (lastPage) => lastPage.next_cursor ?? undefined,
    retry: false,
  });

/**
 * The signed-in pro's earnings, a page per `next_cursor`. The home's wallet card and the Earnings
 * screen share it: the screen opens on what the card loaded. A refetch asks for every loaded page
 * again from the first, each from the fresh page before it, so no row shows twice.
 */
export function useEarnings() {
  const generation = useSessionGeneration();
  const { status, user } = useSession();
  return useInfiniteQuery({
    ...earningsQueryOptions(generation),
    enabled: status === "signedIn" && user?.role === "pro",
  });
}

/**
 * Asks for the first page again and drops the others: the home only shows the totals, so a return
 * to it never asks for every page the Earnings screen scrolled through.
 */
export function useRefreshEarningsTotals(): () => Promise<unknown> {
  const client = useQueryClient();
  const generation = useSessionGeneration();
  return useCallback(() => {
    const queryKey = earningsQueryKey(generation);
    client.setQueryData<EarningsPages>(queryKey, (data) =>
      data && data.pages.length > 1
        ? { pages: data.pages.slice(0, 1), pageParams: data.pageParams.slice(0, 1) }
        : data,
    );
    return client.refetchQueries({ queryKey, exact: true });
  }, [client, generation]);
}

/** The newest answer's totals: the summary covers every job, whichever page carried it. */
export const earningsSummary = (data: EarningsPages | undefined): EarningsSummary | undefined =>
  data?.pages.at(-1)?.summary;

/** The rows of every loaded page, in order, each job once. */
export function flattenEarnings(data: EarningsPages | undefined): Earning[] {
  const seen = new Set<string>();
  const rows: Earning[] = [];
  for (const item of data?.pages.flatMap((page) => page.items) ?? []) {
    if (seen.has(item.job_id)) continue;
    seen.add(item.job_id);
    rows.push(item);
  }
  return rows;
}

/**
 * Why the earnings did not load:
 * - `offline`: no answer (no connection, or a timeout);
 * - `busy`: asked too often in a row (429);
 * - `generic`: anything else. The API's own message is never shown.
 */
export type EarningsFailure = "offline" | "busy" | "generic";

export function earningsFailure(error: unknown): EarningsFailure {
  if (error instanceof NetworkError) return "offline";
  if (error instanceof ApiError && error.status === 429) return "busy";
  return "generic";
}
