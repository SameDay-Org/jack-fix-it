import type { ApiSchema } from "@jack/shared";
import { queryOptions, useQuery } from "@tanstack/react-query";

import { apiGet, ApiError } from "@/api";

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

export const useProProfile = (requestId: string, quoteId: string) =>
  useQuery(proProfileQueryOptions(requestId, quoteId));

/** The quote is no longer in the customer's comparison (404): there is no profile to show for it. */
export const isGone = (error: unknown): boolean =>
  error instanceof ApiError && error.status === 404;
