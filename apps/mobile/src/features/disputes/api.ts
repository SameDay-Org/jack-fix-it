import type { ApiSchema } from "@jack/shared";
import { queryOptions, useQuery, type QueryClient } from "@tanstack/react-query";
import { useIsFocused } from "expo-router";
import { useCallback } from "react";

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
import { refreshCustomerJob, useInForeground } from "@/features/jobs/api";
import { jobsConfig } from "@/features/jobs/config";
import { useRefetchOnReturn } from "@/features/quotes/useRequestQuotes";

export type CustomerDisputeView = ApiSchema<"CustomerDisputeView">;
export type CustomerDispute = ApiSchema<"CustomerDisputeOut">;
export type ProDisputeView = ApiSchema<"ProDisputeView">;
export type ProDispute = ApiSchema<"ProDisputeOut">;
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
 * Why a report or a reply did not go, as the screen says it. `null`: the session ended and the
 * signed-out handling takes over. `closed`: the API refused it for the state of things (a report
 * no longer possible, or one already made with this draft's key; a reply already given, or the
 * report resolved): the screen reads the report again and shows it as it is.
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

/** The report on the pro's job, with the photos' safe copies only and the pro's own reply. */
export const proDisputeKey = (jobId: string, generation: number) =>
  ["pro-dispute", jobId, generation] as const;

export const proDisputeQueryOptions = (jobId: string, generation: number) =>
  queryOptions({
    queryKey: proDisputeKey(jobId, generation),
    queryFn: ({ signal }) =>
      apiGet("/v1/pros/me/jobs/{job_id}/dispute", {
        auth: true,
        signal,
        generation,
        params: { job_id: jobId },
      }),
    retry: false,
  });

/**
 * The report on the pro's job, kept fresh while it is open (#469): asked again on focus and
 * foreground, and every `jobsConfig.pollMs` while the screen is focused and the app in the
 * foreground, until staff resolve it.
 */
export function useProDispute(jobId: string, { enabled = true } = {}) {
  const generation = useSessionGeneration();
  const signedIn = useSession().status === "signedIn";
  const focused = useIsFocused();
  const foreground = useInForeground();
  const live = enabled && signedIn;
  const query = useQuery({
    ...proDisputeQueryOptions(jobId, generation),
    enabled: live,
    refetchInterval: (current) =>
      live && focused && foreground && current.state.data?.dispute?.status === "open"
        ? jobsConfig.pollMs
        : false,
  });
  const { refetch: refetchQuery } = query;
  // `refetch` runs even on a disabled query: nothing is asked for a signed-out session.
  const refetch = useCallback(
    () => (live ? refetchQuery() : Promise.resolve()),
    [live, refetchQuery],
  );
  useRefetchOnReturn(refetch, live);
  return { ...query, refetch };
}

/**
 * The pro's one reply, for the admin who resolves the report. Sending the same text again answers
 * the view unchanged, so a retry after a lost answer is safe. A plain call, as `reportProblem`.
 */
export async function replyToProblem(
  client: QueryClient,
  jobId: string,
  message: string,
  generation: number,
): Promise<ProDisputeView> {
  const view = await apiPost(
    "/v1/pros/me/jobs/{job_id}/dispute/reply",
    { message },
    { auth: true, generation, params: { job_id: jobId } },
  );
  if (isCurrentGeneration(generation)) client.setQueryData(proDisputeKey(jobId, generation), view);
  return view;
}
