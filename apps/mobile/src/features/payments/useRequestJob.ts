import type { ApiSchema } from "@jack/shared";
import { queryOptions, useQuery } from "@tanstack/react-query";

import { apiGet, ApiError } from "@/api";

export type CustomerJob = ApiSchema<"CustomerJob">;

export const jobQueryKey = (requestId: string) => ["requests", requestId, "job"] as const;

/**
 * The job of one of the customer's requests, or `null` while there is none: the API answers 404
 * until the payment succeeds and its webhook creates the job. The 404 is recorded here, as data,
 * so no observer can miss it between two renders. With `generation`, every call belongs to that
 * session only (a payment's confirmation); after a sign-out it sends nothing.
 */
export const jobQueryOptions = (requestId: string, generation?: number) =>
  queryOptions({
    queryKey: jobQueryKey(requestId),
    queryFn: async ({ signal }): Promise<CustomerJob | null> => {
      try {
        return await apiGet("/v1/requests/{request_id}/job", {
          auth: true,
          signal,
          generation,
          params: { request_id: requestId },
        });
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) return null;
        throw error;
      }
    },
    retry: false,
  });

/**
 * The request's job. With `pollMs`, it asks again at that interval until the job exists: the
 * caller turns it off when the screen loses focus, the wait times out or the session ends.
 */
export function useRequestJob(
  requestId: string,
  { pollMs, generation }: { pollMs: number | false; generation?: number },
) {
  return useQuery({
    ...jobQueryOptions(requestId, generation),
    refetchInterval: (query) => (query.state.data ? false : pollMs),
  });
}
