import { queryOptions, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useIsFocused } from "expo-router";
import { useCallback, useSyncExternalStore } from "react";
import { AppState } from "react-native";

import {
  apiGet,
  ApiError,
  apiPost,
  isCurrentGeneration,
  useSession,
  useSessionGeneration,
} from "@/api";
import { invalidateMyRequests, MY_REQUESTS_PAGE_SIZE } from "@/features/history/useMyRequests";
import { useRefetchOnReturn } from "@/features/quotes/useRequestQuotes";

import { jobsConfig } from "./config";
import { isActive, isMoving, pickActive, type ActiveJob, type CustomerJob } from "./phase";

type Href = { pathname: "/requests/[id]/job"; params: { id: string } };

/** The ongoing job screen of one request. */
export const jobHref = (requestId: string): Href => ({
  pathname: "/requests/[id]/job",
  params: { id: requestId },
});

/** The confirmation sheet over a finished job (#66). */
export const confirmJobHref = (requestId: string) =>
  ({ pathname: "/requests/[id]/confirm", params: { id: requestId } }) as const;

/** The job's after photos full screen, starting at the `index`th one. */
export const jobPhotosHref = (requestId: string, index: number) =>
  ({ pathname: "/requests/[id]/photos", params: { id: requestId, index: String(index) } }) as const;

/**
 * One request's job, as the session that asked for it sees it: the generation is part of the key
 * and pins every call (`RequestOptions.generation`), so an answer for a session that is gone can
 * never land where the next one reads.
 */
export const customerJobQueryKey = (requestId: string, generation: number) =>
  ["job", requestId, generation] as const;

/** No job on the request yet: the payment has not created it (404, as for anyone else's request). */
export const isNoJobYet = (error: unknown): boolean =>
  error instanceof ApiError && error.status === 404;

/**
 * The customer's job on one of their requests (#63). A 404 means the payment has not created it
 * yet; it is shown as such and asked again like a moving job, not retried in a burst.
 */
export const customerJobQueryOptions = (requestId: string, generation: number) =>
  queryOptions({
    queryKey: customerJobQueryKey(requestId, generation),
    queryFn: ({ signal }) =>
      apiGet("/v1/requests/{request_id}/job", {
        auth: true,
        signal,
        generation,
        params: { request_id: requestId },
      }),
    retry: false,
  });

const subscribeAppState = (onChange: () => void) => {
  const subscription = AppState.addEventListener("change", onChange);
  return () => subscription.remove();
};
const inForeground = () => AppState.currentState !== "background";

/** The app is on screen (not in the background), as React state. */
export const useInForeground = (): boolean =>
  useSyncExternalStore(subscribeAppState, inForeground, inForeground);

/**
 * The job, kept fresh without push (#65 is not built): asked again whenever the screen comes back
 * into focus or the app back to the foreground, and every `jobsConfig.pollMs` while the screen is
 * focused, the app is in the foreground and the pro can still move the job (or the payment has not
 * created it yet). A blur, the background or a sign-out stops the asking: the signed-out shell
 * unmounts the screen, and a key from a signed-out session is never enabled.
 */
export function useCustomerJob(requestId: string, { enabled = true, poll = true } = {}) {
  const generation = useSessionGeneration();
  const signedIn = useSession().status === "signedIn";
  const focused = useIsFocused();
  const foreground = useInForeground();
  const live = enabled && signedIn;
  const polling = live && poll && focused && foreground;

  const query = useQuery({
    ...customerJobQueryOptions(requestId, generation),
    enabled: live,
    refetchInterval: (current) => {
      if (!polling) return false;
      const job = current.state.data;
      const waiting = job ? isMoving(job) : isNoJobYet(current.state.error);
      if (waiting) return jobsConfig.pollMs;
      // A finished job is asked for again when its automatic confirmation is due, then polled
      // until the worker confirms it: "any moment now" turns into the confirmed job by itself.
      if (job?.status !== "completed" || job.confirm_by === null) return false;
      const left = Date.parse(job.confirm_by) - Date.now();
      if (!Number.isFinite(left)) return false;
      return left <= 0
        ? jobsConfig.pollMs
        : Math.min(MAX_TIMER_MS, Math.max(jobsConfig.pollMs, left));
    },
  });
  useRefetchOnReturn(query.refetch, live);
  return query;
}

// The banner asks for the newest page of requests, as History's first page does.
const ACTIVE_JOB_KEY = "active-job";
export const activeJobQueryKey = (generation: number) => [ACTIVE_JOB_KEY, generation] as const;

/**
 * The customer's one active job, for the tabs' banner: the newest page of their requests, then
 * the job of each accepted one, every call pinned to one session generation, so the chain never
 * mixes two accounts. Each job lands in its own query (the screen the banner opens draws at once);
 * a job past the banner's phases never comes back to them, so its cached answer is reused.
 * Requests past the first page are not looked at.
 */
export const activeJobQueryOptions = (client: QueryClient, generation: number) =>
  queryOptions({
    queryKey: activeJobQueryKey(generation),
    queryFn: async ({ signal }): Promise<ActiveJob | null> => {
      const page = await apiGet("/v1/requests", {
        auth: true,
        signal,
        generation,
        query: { limit: MY_REQUESTS_PAGE_SIZE },
      });
      const accepted = page.items.filter((request) => request.status === "accepted");
      const jobs = await Promise.all(
        accepted.map(async ({ id }): Promise<ActiveJob | null> => {
          try {
            const job = await client.fetchQuery({
              ...customerJobQueryOptions(id, generation),
              staleTime: (query) => {
                const cached = query.state.data as CustomerJob | undefined;
                return cached && !isActive(cached) ? Infinity : 0;
              },
            });
            return { requestId: id, job };
          } catch (error) {
            if (isNoJobYet(error)) return null; // accepted, not paid yet
            throw error;
          }
        }),
      );
      return pickActive(jobs.filter((job): job is ActiveJob => job !== null));
    },
    retry: false,
  });

/**
 * The banner's job for a signed-in customer (pros have no requests): null when none is active.
 * The job is read back from its own query, so a screen that polled it since (the pro moved on,
 * the customer confirmed) shows in the banner at once. Nothing is asked for while signed out.
 */
export type ActiveJobState = {
  active: ActiveJob | null;
  /** When the job on show was last answered: its words are never drawn against an older clock. */
  updatedAt: number;
  refetch: () => Promise<unknown>;
};

export function useActiveJob(): ActiveJobState {
  const client = useQueryClient();
  const generation = useSessionGeneration();
  const { status, user } = useSession();
  const enabled = status === "signedIn" && user?.role === "customer";
  const {
    data,
    refetch,
    dataUpdatedAt: listedAt,
  } = useQuery({ ...activeJobQueryOptions(client, generation), enabled });
  const found = enabled ? (data ?? null) : null;
  const { data: latest, dataUpdatedAt: jobAt } = useQuery({
    ...customerJobQueryOptions(found?.requestId ?? "", generation),
    enabled: false,
  });
  const job = found && latest ? latest : found?.job;
  const active = found && job && isActive(job) ? { requestId: found.requestId, job } : null;
  // `refetch` runs even on a disabled query: a pro (no requests) would be refused each time.
  const refresh = useCallback(() => (enabled ? refetch() : Promise.resolve()), [enabled, refetch]);
  return { active, updatedAt: Math.max(listedAt, jobAt), refetch: refresh };
}

// setTimeout's ceiling (about 24.8 days).
const MAX_TIMER_MS = 2 ** 31 - 1;

/**
 * A mark that this session confirmed the job from this phone, so the confirmed screen thanks the
 * customer for their own confirmation only (the automatic one landing under their eyes reads "Job
 * confirmed"). It lives in the session's cache, keyed by its generation, and goes with it.
 */
const confirmedHereKey = (requestId: string, generation: number) =>
  ["job-confirmed-here", requestId, generation] as const;
export const wasConfirmedHere = (
  client: QueryClient,
  requestId: string,
  generation: number,
): boolean => client.getQueryData<boolean>(confirmedHereKey(requestId, generation)) === true;

/**
 * The customer confirms the finished job is done (#66): completed -> confirmed, or the job as it
 * is when it was confirmed already. The answer replaces the job on screen at once (the screen
 * under the sheet turns to "confirmed" as the sheet closes, and the banner, which reads the same
 * query, lets it go), and the banner's list and History are asked again. Every step is pinned to
 * the session the confirmation started in: after a sign-out the answer goes nowhere.
 */
export async function confirmJob(
  client: QueryClient,
  requestId: string,
  generation: number,
): Promise<CustomerJob> {
  const job = await apiPost("/v1/requests/{request_id}/job/confirm", undefined, {
    auth: true,
    generation,
    params: { request_id: requestId },
  });
  if (isCurrentGeneration(generation)) {
    client.setQueryData(confirmedHereKey(requestId, generation), true);
    client.setQueryData(customerJobQueryKey(requestId, generation), job);
    void client.invalidateQueries({ queryKey: activeJobQueryKey(generation) });
    void invalidateMyRequests(client);
  }
  return job;
}

/** The job and the banner's list asked again: a confirmation found the job moved on or gone. */
export function refreshCustomerJob(client: QueryClient, requestId: string, generation: number) {
  if (!isCurrentGeneration(generation)) return;
  void client.invalidateQueries({ queryKey: customerJobQueryKey(requestId, generation) });
  void client.invalidateQueries({ queryKey: activeJobQueryKey(generation) });
}
