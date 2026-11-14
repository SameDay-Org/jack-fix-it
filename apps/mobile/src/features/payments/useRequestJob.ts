import type { ApiSchema } from "@jack/shared";
import { queryOptions, useQuery, type QueryClient } from "@tanstack/react-query";

import { apiGet, ApiError, isCurrentGeneration, sessionGeneration } from "@/api";
import { customerJobQueryKey } from "@/features/jobs/api";

export type CustomerJob = ApiSchema<"CustomerJob">;

export const jobQueryKey = (requestId: string) => ["requests", requestId, "job"] as const;

/**
 * Hands a job the card found to the request's notice (#64) when the notice has none: its own look
 * failed (a 503) or came just before the webhook made the job (a 404), and it is never polled.
 * Written under the session the look started in, before the card's answer is published (both land
 * together), and only while that session is current and the look was not cancelled (a sign-out
 * clears the cache): no other session reads it.
 */
function fillNotice(
  client: QueryClient,
  requestId: string,
  generation: number,
  job: CustomerJob,
  signal: AbortSignal,
): void {
  if (signal.aborted || !isCurrentGeneration(generation)) return;
  const queryKey = customerJobQueryKey(requestId, generation);
  if (client.getQueryData(queryKey) === undefined) client.setQueryData(queryKey, job);
}

/**
 * The job of one of the customer's requests, or `null` while there is none: the API answers 404
 * until the payment succeeds and its webhook creates the job. The 404 is recorded here, as data,
 * so no observer can miss it between two renders. With `generation`, every call belongs to that
 * session only (a payment's confirmation); after a sign-out it sends nothing. Without it, the call
 * belongs to the session current when it starts. A job found fills the notice (`fillNotice`).
 */
export const jobQueryOptions = (requestId: string, generation?: number) =>
  queryOptions({
    queryKey: jobQueryKey(requestId),
    queryFn: async ({ signal, client }): Promise<CustomerJob | null> => {
      const startedIn = generation ?? sessionGeneration();
      try {
        const job = await apiGet("/v1/requests/{request_id}/job", {
          auth: true,
          signal,
          generation,
          params: { request_id: requestId },
        });
        fillNotice(client, requestId, startedIn, job, signal);
        return job;
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
