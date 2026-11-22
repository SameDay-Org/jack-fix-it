import { infiniteQueryOptions, useInfiniteQuery } from "@tanstack/react-query";

import { apiGet, useSession, useSessionGeneration, type GetResponse } from "@/api";

export type PublicReviewPage = GetResponse<"/v1/pros/{pro_id}/reviews">;
export type PublicReview = PublicReviewPage["items"][number];
/** The cursor of a page: none for the first, the previous page's `next_cursor` after that. */
type Cursor = string | undefined;

/** Reviews per page on the profile: a few under the pro's figures, more on request. */
export const PRO_REVIEWS_PAGE_SIZE = 5;

/**
 * A pro's published reviews (#78), newest first as the API orders them, a page per
 * `next_cursor`. Keyed by the session's generation, which pins the call, so another session's
 * answer never lands here.
 */
export const proReviewsQueryKey = (proId: string, generation: number) =>
  ["pro-reviews", proId, generation] as const;

export const proReviewsQueryOptions = (proId: string, generation: number) =>
  infiniteQueryOptions({
    queryKey: proReviewsQueryKey(proId, generation),
    queryFn: ({ pageParam, signal }) =>
      apiGet("/v1/pros/{pro_id}/reviews", {
        auth: true,
        signal,
        generation,
        params: { pro_id: proId },
        query: { limit: PRO_REVIEWS_PAGE_SIZE, cursor: pageParam },
      }),
    initialPageParam: undefined as Cursor,
    getNextPageParam: (lastPage) => lastPage.next_cursor ?? undefined,
    retry: false,
  });

export function useProReviews(proId: string) {
  const generation = useSessionGeneration();
  const signedIn = useSession().status === "signedIn";
  return useInfiniteQuery({ ...proReviewsQueryOptions(proId, generation), enabled: signedIn });
}
