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

export type CustomerDisputeView = ApiSchema<"CustomerDisputeView">;
export type CustomerDispute = ApiSchema<"CustomerDisputeOut">;
export type DisputeReason = CustomerDispute["reason_code"];
export type DisputeResolution = NonNullable<CustomerDispute["resolution"]>;

/** The reasons, in the order the form lists them (`DisputeReason` in the API). */
export const DISPUTE_REASONS: readonly DisputeReason[] = [
  "work_incomplete",
  "poor_quality",
  "no_show",
  "damage",
  "other",
];

/** The report form's route over the job: the full screen to report a problem with it. */
export const reportProblemHref = (requestId: string) =>
  ({ pathname: "/requests/[id]/report", params: { id: requestId } }) as const;

/**
 * The customer's report on their job, or none, whether they may report one now and until when
 * (`report_by`, the API's own deadline: the phone never works the window out). Keyed by the
 * session's generation, which pins the call, so another session's answer never lands here.
 */
export const customerDisputeKey = (jobId: string, generation: number) =>
  ["dispute", jobId, generation] as const;

export const customerDisputeQueryOptions = (jobId: string, generation: number) =>
  queryOptions({
    queryKey: customerDisputeKey(jobId, generation),
    queryFn: ({ signal }) =>
      apiGet("/v1/jobs/{job_id}/dispute", {
        auth: true,
        signal,
        generation,
        params: { job_id: jobId },
      }),
    retry: false,
  });

export function useCustomerDispute(jobId: string | undefined, { enabled = true } = {}) {
  const generation = useSessionGeneration();
  const signedIn = useSession().status === "signedIn";
  return useQuery({
    ...customerDisputeQueryOptions(jobId ?? "", generation),
    enabled: enabled && signedIn && jobId !== undefined,
  });
}

export type ReportBody = {
  reason_code: DisputeReason;
  description: string;
  photo_keys: string[];
};

/**
 * Sends the report: one Idempotency-Key per draft, sent again with every retry, so a double tap
 * or a retry after a lost answer makes one report (the API answers the first one, 200). A plain
 * call and not a mutation: a mutation keeps its variables, here the text, in the app-wide
 * MutationCache. The answer is the report as it is now; the job moved to disputed, so it and the
 * lists that show its status are asked again. Pinned to the session it was written in.
 */
export async function reportProblem(
  client: QueryClient,
  report: { jobId: string; requestId: string; body: ReportBody; idempotencyKey: string },
  generation: number,
): Promise<CustomerDisputeView> {
  const view = await apiPost("/v1/jobs/{job_id}/dispute", report.body, {
    auth: true,
    generation,
    idempotencyKey: report.idempotencyKey,
    params: { job_id: report.jobId },
  });
  if (!isCurrentGeneration(generation)) return view;
  client.setQueryData(customerDisputeKey(report.jobId, generation), view);
  refreshCustomerJob(client, report.requestId, generation);
  void invalidateMyRequests(client);
  return view;
}

/**
 * Why a report did not go, as the screen says it. `null`: the session ended and the signed-out
 * handling takes over. `closed`: the API refused it for the job's state (a report no longer
 * possible, or one already made with this draft's key): the screen reads the report again and
 * shows it as it is.
 */
export type SendFailure = "offline" | "closed" | "invalid" | "failed";

export function sendFailureOf(error: unknown): SendFailure | null {
  if (error instanceof SessionExpiredError) return null;
  if (error instanceof NetworkError) return "offline";
  if (error instanceof ApiError) {
    if (error.status === 409) return "closed";
    if (error.status === 422) return "invalid";
  }
  return "failed";
}
