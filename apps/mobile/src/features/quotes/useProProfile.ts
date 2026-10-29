import type { ApiSchema } from "@jack/shared";
import { queryOptions, useQuery, type QueryClient } from "@tanstack/react-query";

import { apiGet, ApiError } from "@/api";

import { quotesQueryKey } from "./useRequestQuotes";

export type ProPublicProfile = ApiSchema<"ProPublicProfile">;

/** Its own key, not under the request's quotes: the list's invalidations do not refetch it. */
export const proProfileQueryKey = (requestId: string, quoteId: string) =>
  ["requests", requestId, "quote-pro", quoteId] as const;

/**
 * The public profile of the pro behind one quote the customer is comparing (#53). The API answers
 * 404 once the quote left the comparison (expired, withdrawn, another request) and 403 to anyone
 * but a customer; neither improves by asking again, and a failure shows with a retry.
 */
export const proProfileQueryOptions = (requestId: string, quoteId: string) =>
  queryOptions({
    queryKey: proProfileQueryKey(requestId, quoteId),
    queryFn: ({ signal }) =>
      apiGet("/v1/requests/{request_id}/quotes/{quote_id}/pro", {
        auth: true,
        signal,
        params: { request_id: requestId, quote_id: quoteId },
      }),
    retry: false,
  });

/** `enabled` false asks nothing, and shows nothing it held (a denial, ids that are not ids). */
export const useProProfile = (requestId: string, quoteId: string, enabled = true) =>
  useQuery({ ...proProfileQueryOptions(requestId, quoteId), enabled });

/** The quote is no longer in the customer's comparison (404): there is no profile to show for it. */
export const isGone = (error: unknown): boolean =>
  error instanceof ApiError && error.status === 404;

/** The API refused this profile (404 or 403): what an earlier answer held may not show again. */
export const isDenied = (error: unknown): error is ApiError =>
  error instanceof ApiError && (error.status === 404 || error.status === 403);

/**
 * After a denial: the profile leaves the cache, so no later answer (offline, a 5xx) can show it
 * again; only a new 200 can. On a 404 the quote also left the comparison, whose list is told so
 * its card goes too, whether or not a profile was ever cached.
 */
export function forgetProProfile(
  client: QueryClient,
  requestId: string,
  quoteId: string,
  status: number,
): void {
  client.removeQueries({ queryKey: proProfileQueryKey(requestId, quoteId), exact: true });
  if (status === 404) void client.invalidateQueries({ queryKey: quotesQueryKey(requestId) });
}
