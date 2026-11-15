import type { ApiSchema } from "@jack/shared";
import { useQuery, type QueryClient } from "@tanstack/react-query";

import {
  ApiError,
  apiGet,
  apiPost,
  isCurrentGeneration,
  NetworkError,
  SessionExpiredError,
  useSession,
  useSessionGeneration,
} from "@/api";
import type { StarScore } from "@/components/ui";
import { isUuid } from "@/features/quotes/navigation";

export type ReviewBody = ApiSchema<"ReviewIn">;
export type MyRating = ApiSchema<"RatingOut">;

/** Who writes the review: the job's customer rates the pro, the job's pro rates the customer. */
export type ReviewSide = "customer" | "pro";

/** The optional ratings beside `overall`. */
export type Dimension = "communication" | "quality" | "punctuality" | "value";
export type Aspect = "overall" | Dimension;

/** What each side may rate besides `overall`: quality and value come from the customer only. */
export const DIMENSIONS: Record<ReviewSide, readonly Dimension[]> = {
  customer: ["communication", "quality", "punctuality", "value"],
  pro: ["communication", "punctuality"],
};

/** The API's limit for a comment (`COMMENT_MAX_LENGTH`). */
export const COMMENT_MAX = 1000;

/**
 * The caller's own review of a job, as the app keeps it: whether they may still write one, and the
 * overall stars of the one they wrote. Never its comment, and never the other side's review (the
 * API does not send that one).
 */
export type MyReview = { canReview: boolean; rated: number | null };

// The keys name the job and the session, never anything typed.
export const myReviewKey = (jobId: string, generation: number) =>
  ["reviews", "mine", jobId, generation] as const;
export const myRatingKey = (generation: number) => ["rating", "mine", generation] as const;

/** The rating screen of a job, for its customer (with their request) or its pro. */
export const rateHref = (jobId: string, requestId?: string) =>
  ({
    pathname: "/jobs/[id]/rate",
    params: requestId === undefined ? { id: jobId } : { id: jobId, request: requestId },
  }) as const;

/** `GET /v1/jobs/{job_id}/reviews/mine`, read while `enabled` and signed in; never retried alone. */
export function useMyReview(jobId: string, enabled = true) {
  const generation = useSessionGeneration();
  const { status } = useSession();
  return useQuery({
    queryKey: myReviewKey(jobId, generation),
    queryFn: async ({ signal }): Promise<MyReview> => {
      const { review, can_review } = await apiGet("/v1/jobs/{job_id}/reviews/mine", {
        auth: true,
        signal,
        generation,
        params: { job_id: jobId },
      });
      return { canReview: can_review, rated: review?.overall ?? null };
    },
    enabled: enabled && status === "signedIn" && isUuid(jobId),
    retry: false,
  });
}

/**
 * The signed-in person's rating (`GET /v1/users/me/rating`): the average and how many. It changes
 * when the other side's review publishes, not on this phone: a screen that stays mounted (a tab)
 * passes `subscribed` false while hidden, and showing again reads it anew.
 */
export function useMyRating(subscribed = true) {
  const generation = useSessionGeneration();
  const { status } = useSession();
  return useQuery({
    queryKey: myRatingKey(generation),
    queryFn: ({ signal }) => apiGet("/v1/users/me/rating", { auth: true, signal, generation }),
    enabled: status === "signedIn",
    subscribed,
    retry: false,
  });
}

/** The draft as the API takes it from this side, or null while it cannot go (no overall, too long). */
export function reviewBodyOf(
  side: ReviewSide,
  ratings: Partial<Record<Aspect, StarScore>>,
  comment: string,
): ReviewBody | null {
  const { overall } = ratings;
  if (overall === undefined || comment.length > COMMENT_MAX) return null;
  const body: ReviewBody = { overall };
  // Only what this side may rate: a pro's draft never sends quality or value.
  for (const dimension of DIMENSIONS[side]) {
    const score = ratings[dimension];
    if (score !== undefined) body[dimension] = score;
  }
  const text = comment.trim();
  if (text !== "") body.comment = text;
  return body;
}

/**
 * Sends the review once. The comment goes in the request body and nowhere else: not in a key, a
 * log or the cache (a plain call, not a mutation, so no MutationCache holds it). Pinned to the
 * session it was written in. On success the job's "mine" turns to the stars just given at once
 * (a read in flight was answered before, so it is cancelled first) and the person's rating is read
 * again: their own review can publish the other side's. A 409 reads "mine" again before it is
 * thrown, so the screen it lands on already shows where the job stands. Resolves to whether
 * contact details were masked in the comment.
 */
export async function sendReview(
  client: QueryClient,
  jobId: string,
  body: ReviewBody,
  generation: number,
): Promise<boolean> {
  const mine = myReviewKey(jobId, generation);
  let created;
  try {
    created = await apiPost("/v1/jobs/{job_id}/reviews", body, {
      auth: true,
      generation,
      params: { job_id: jobId },
    });
  } catch (error) {
    if (isCurrentGeneration(generation) && error instanceof ApiError && error.status === 409) {
      await client.invalidateQueries({ queryKey: mine, exact: true });
    }
    // No answer is not a refusal: the review may have arrived, and the next read says so.
    if (isCurrentGeneration(generation) && error instanceof NetworkError) {
      void client.invalidateQueries({ queryKey: mine, exact: true });
    }
    throw error;
  }
  if (!isCurrentGeneration(generation)) return created.comment_redacted;
  await client.cancelQueries({ queryKey: mine, exact: true });
  if (isCurrentGeneration(generation)) {
    client.setQueryData<MyReview>(mine, { canReview: false, rated: body.overall });
    void client.invalidateQueries({ queryKey: myRatingKey(generation) });
  }
  return created.comment_redacted;
}

/**
 * Why a review did not go, as the screen explains it. `null`: the session ended, and the
 * signed-out handling takes over.
 */
export type ReviewFailure =
  "offline" | "rateLimited" | "alreadyReviewed" | "notReviewable" | "gone" | "failed";

export function reviewFailureOf(error: unknown): ReviewFailure | null {
  if (error instanceof SessionExpiredError) return null;
  if (error instanceof NetworkError) return "offline";
  if (error instanceof ApiError) {
    if (error.status === 429) return "rateLimited";
    if (error.status === 409 && error.code === "already_reviewed") return "alreadyReviewed";
    if (error.status === 409) return "notReviewable";
    // Not this person's job, or no such job: as final as elsewhere.
    if (error.status === 404 || error.status === 403) return "gone";
  }
  return "failed";
}
