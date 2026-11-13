import { queryOptions, useQuery } from "@tanstack/react-query";

import { apiGet } from "@/api";

/** Beside the request's quotes, under its own name: refreshing the quotes never refetches it. */
export const myRequestQueryKey = (requestId: string) => ["requests", requestId, "detail"] as const;

/**
 * One of the customer's requests as they sent it. Only what never changes after the send is read
 * from it (the preferred day and its period), so one answer serves for as long as it is cached,
 * and a failure costs only the line it feeds: the quotes carry the screen's own states.
 */
export const myRequestQueryOptions = (requestId: string) =>
  queryOptions({
    queryKey: myRequestQueryKey(requestId),
    queryFn: ({ signal }) =>
      apiGet("/v1/requests/{request_id}", {
        auth: true,
        signal,
        params: { request_id: requestId },
      }),
    staleTime: Infinity,
    retry: false,
  });

export const useMyRequest = (requestId: string) => useQuery(myRequestQueryOptions(requestId));
