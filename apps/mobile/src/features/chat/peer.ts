import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";

import { isCurrentGeneration, useSession, useSessionGeneration } from "@/api";
import { customerJobQueryKey, useCustomerJob } from "@/features/jobs/api";
import { firstName, type CustomerJob, type JobStatus } from "@/features/jobs/phase";
import { isUuid } from "@/features/quotes/navigation";
import { proJobQueryOptions, proJobsQueryKey } from "@/features/pro-jobs/api";
import type { ProJob } from "@/features/pro-jobs/phase";
import { useRefetchOnReturn } from "@/features/quotes/useRequestQuotes";

/**
 * The job statuses whose chat is read-only (`chat_closed`, #71): confirmed, paid out, refunded or
 * cancelled. A 409 on send says the same when the job closed after the view was answered.
 */
const CLOSED: ReadonlySet<JobStatus> = new Set(["confirmed", "paid_out", "refunded", "cancelled"]);
export const isChatClosed = (status: JobStatus): boolean => CLOSED.has(status);

export type ChatPeer = {
  /** Who is on the other side: a customer's chat is with the pro, a pro's with the customer. */
  role: "pro" | "customer";
  /** Their first name; null while the job view is not known or when the API withholds it. */
  firstName: string | null;
  /** The name as the API gives it ("Dan R."), for the initials; null as for `firstName`. */
  fullName: string | null;
  /** The job view says the chat is read-only. */
  closed: boolean;
  /** The job view has answered (the header stops showing its placeholder). */
  known: boolean;
  /** The caller's unread count moved (a read marker): the job view shows the new count at once. */
  onUnread: (count: number) => void;
};

/**
 * The other side of one job's chat, from the job view the caller already holds: the customer's
 * job of `requestId` (only when it is this job), or the pro's job. Each is asked again when the
 * chat comes back into focus; nothing is asked for a signed-out session or a malformed id.
 */
export function useChatPeer(jobId: string, requestId: string | undefined): ChatPeer {
  const { status, user } = useSession();
  const signedIn = status === "signedIn";
  const isPro = user?.role === "pro";
  const validJob = isUuid(jobId);
  const customerRequest = !isPro && isUuid(requestId) ? requestId : "";

  const customer = useCustomerJob(customerRequest, {
    enabled: signedIn && !isPro && validJob && customerRequest !== "",
    poll: false,
  });
  const pro = useProJobView(jobId, signedIn && isPro && validJob);
  const client = useQueryClient();
  const generation = useSessionGeneration();

  const customerJob: CustomerJob | undefined =
    customer.data?.id === jobId ? customer.data : undefined;
  const proJob: ProJob | undefined = pro.data?.id === jobId ? pro.data : undefined;

  const onUnread = useCallback(
    (count: number) => {
      if (!isCurrentGeneration(generation)) return;
      const patch = <T extends { id: string; unread_messages: number }>(job: T | undefined) =>
        job && job.id === jobId ? { ...job, unread_messages: count } : job;
      if (isPro) {
        // The job screen's answer and the job's row in "Your jobs" on the pro's home.
        client.setQueryData<ProJob>(proJobQueryOptions(jobId, generation).queryKey, patch);
        client.setQueryData<ProJob[]>(proJobsQueryKey(generation), (jobs) =>
          jobs?.map((job) => (job.id === jobId ? { ...job, unread_messages: count } : job)),
        );
      } else if (customerRequest !== "") {
        client.setQueryData<CustomerJob>(customerJobQueryKey(customerRequest, generation), patch);
      }
    },
    [client, customerRequest, generation, isPro, jobId],
  );

  if (isPro) {
    return {
      role: "customer",
      firstName: firstName(proJob?.customer_first_name ?? null),
      fullName: proJob?.customer_first_name?.trim() || null,
      closed: proJob ? isChatClosed(proJob.status) : false,
      known: proJob !== undefined || pro.isError,
      onUnread,
    };
  }
  return {
    role: "pro",
    firstName: firstName(customerJob?.pro.name ?? null),
    fullName: customerJob?.pro.name?.trim() || null,
    closed: customerJob ? isChatClosed(customerJob.status) : false,
    known: customerJob !== undefined || customer.isError || customerRequest === "",
    onUnread,
  };
}

/** The pro's view of one of their jobs, asked when the chat opens and again on its return. */
function useProJobView(jobId: string, enabled: boolean) {
  const generation = useSessionGeneration();
  const query = useQuery({ ...proJobQueryOptions(jobId, generation), enabled });
  const { refetch: refetchQuery } = query;
  const refetch = useCallback(
    () => (enabled ? refetchQuery() : Promise.resolve()),
    [enabled, refetchQuery],
  );
  useRefetchOnReturn(refetch, enabled);
  return query;
}
