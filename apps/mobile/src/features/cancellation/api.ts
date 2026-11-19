import type { ApiSchema } from "@jack/shared";
import { queryOptions, useQuery, type QueryClient } from "@tanstack/react-query";

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
import { invalidateMyRequests } from "@/features/history/useMyRequests";
import { refreshCustomerJob } from "@/features/jobs/api";

export type CancelPreview = ApiSchema<"CancelPreviewOut">;
export type Cancellation = ApiSchema<"CancellationOut">;
export type JobCancellation = ApiSchema<"CustomerJobCancellation">;
export type CancelReason = ApiSchema<"CustomerCancelReason">;
export type CancelBody = ApiSchema<"CustomerCancelIn">;

/** The reasons, in the order the screen lists them (`CustomerCancelReason` in the API). */
export const CANCEL_REASONS: readonly CancelReason[] = [
  "changed_my_mind",
  "found_another_pro",
  "pro_late",
  "other",
];

/** The job's statuses the API lets its customer cancel: only these ask for the preview. */
const CANCELLABLE: ReadonlySet<string> = new Set(["scheduled", "on_the_way"]);
export const mayCancel = (status: string): boolean => CANCELLABLE.has(status);

/** The cancel screen's route over the job. */
export const cancelJobHref = (requestId: string) =>
  ({ pathname: "/requests/[id]/cancel", params: { id: requestId } }) as const;

/**
 * What cancelling the job now would cost, computed by the API (`GET …/cancel-preview`): the fee it
 * keeps (none before the pro is on the way) and what goes back to the customer. The phone never
 * works an amount out. A 409 means the job cannot be cancelled now. Keyed by the session's
 * generation, which pins the call, so another session's answer never lands here.
 */
export const cancelPreviewKey = (jobId: string, generation: number) =>
  ["cancel-preview", jobId, generation] as const;

export const cancelPreviewQueryOptions = (jobId: string, generation: number) =>
  queryOptions({
    queryKey: cancelPreviewKey(jobId, generation),
    queryFn: ({ signal }) =>
      apiGet("/v1/jobs/{job_id}/cancel-preview", {
        auth: true,
        signal,
        generation,
        params: { job_id: jobId },
      }),
    retry: false,
  });

export function useCancelPreview(jobId: string | undefined, { enabled = true } = {}) {
  const generation = useSessionGeneration();
  const signedIn = useSession().status === "signedIn";
  return useQuery({
    ...cancelPreviewQueryOptions(jobId ?? "", generation),
    enabled: enabled && signedIn && jobId !== undefined,
  });
}

/** The API says the job cannot be cancelled now (or not before staff look at its payment). */
export type Refusal = "notAllowed" | "needsReview";

export function refusalOf(error: unknown): Refusal | null {
  if (!(error instanceof ApiError) || error.status !== 409) return null;
  if (error.code === "cancel_needs_review") return "needsReview";
  return error.code === "cancel_not_allowed" ? "notAllowed" : null;
}

/**
 * Cancels the job: one Idempotency-Key per screen, sent again with every retry, so a double tap or
 * a retry after a lost answer cancels once (the API answers with the cancellation as it is). The
 * preview's fee goes along as `expected_fee_cents`: if the cost changed since (the pro set off),
 * nothing happens and the API says so. Never an amount the phone made. A plain call, not a
 * mutation: a mutation keeps its variables, the note here, in the app-wide MutationCache. The job,
 * its preview and the lists that show it are read again. Pinned to the session it was asked in.
 */
export async function cancelJob(
  client: QueryClient,
  cancel: { jobId: string; requestId: string; body: CancelBody; idempotencyKey: string },
  generation: number,
): Promise<Cancellation> {
  const answer = await apiPost("/v1/jobs/{job_id}/cancel", cancel.body, {
    auth: true,
    generation,
    idempotencyKey: cancel.idempotencyKey,
    params: { job_id: cancel.jobId },
  });
  if (!isCurrentGeneration(generation)) return answer;
  void client.invalidateQueries({ queryKey: cancelPreviewKey(cancel.jobId, generation) });
  refreshCustomerJob(client, cancel.requestId, generation);
  void invalidateMyRequests(client);
  return answer;
}

/**
 * Why a cancel did not go, as the screen says it. `null`: the session ended and the signed-out
 * handling takes over. `feeChanged`: the cost moved since the preview (the pro set off): the
 * screen reads it again. `closed`: the job cannot be cancelled now: the screen reads it again and
 * shows why.
 */
export type CancelFailure = "offline" | "feeChanged" | "closed" | "invalid" | "failed";

export function cancelFailureOf(error: unknown): CancelFailure | null {
  if (error instanceof SessionExpiredError) return null;
  if (error instanceof NetworkError) return "offline";
  if (error instanceof ApiError) {
    if (error.status === 409) return error.code === "cancel_fee_changed" ? "feeChanged" : "closed";
    if (error.status === 422) return "invalid";
  }
  return "failed";
}
