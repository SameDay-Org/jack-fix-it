import { useQuery } from "@tanstack/react-query";

import { apiGet, type GetResponse } from "@/api";

export type SavedAddress = GetResponse<"/v1/addresses">["items"][number];

export const SAVED_ADDRESSES_QUERY_KEY = ["addresses"] as const;

/**
 * The customer's saved addresses (D8.2, #214): at most four, one of them the default, each saying
 * whether its ZIP is served. A failure is shown with a retry, not retried behind a skeleton.
 */
export const useSavedAddresses = () =>
  useQuery({
    queryKey: SAVED_ADDRESSES_QUERY_KEY,
    queryFn: ({ signal }) => apiGet("/v1/addresses", { auth: true, signal }),
    retry: false,
  });
