import { queryOptions, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";

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
import { isUuid } from "@/features/quotes/navigation";
import { useRefetchOnReturn } from "@/features/quotes/useRequestQuotes";

import type { CheckInPosition } from "./location";
import { isActiveJob, soonestFirst, type ProJob } from "./phase";

const PRO_JOBS = "pro-jobs";

/**
 * The pro's active jobs as the session that asked for them sees them: the generation is part of
 * every key and pins every call (`RequestOptions.generation`), so an answer for a session that is
 * gone never lands where the next one reads.
 */
export const proJobsQueryKey = (generation: number) => [PRO_JOBS, "active", generation] as const;
export const proJobQueryKey = (jobId: string, generation: number) =>
  [PRO_JOBS, "job", jobId, generation] as const;

/** The job screen's link (the deep link #65's pushes use, `/jobs/<id>`). */
export const proJobHref = (jobId: string) =>
  ({ pathname: "/jobs/[id]", params: { id: jobId } }) as const;

/**
 * Every active job of the pro (scheduled, on the way, working), soonest first. The API pages
 * newest first, so every page is read before sorting; a pro holds a handful at a time. A cursor
 * that comes back twice ends the read rather than looping.
 */
async function fetchActiveJobs(generation: number, signal: AbortSignal): Promise<ProJob[]> {
  const jobs: ProJob[] = [];
  const cursors = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await apiGet("/v1/pros/me/jobs", {
      auth: true,
      signal,
      generation,
      query: { active: "true", cursor },
    });
    jobs.push(...page.items);
    cursor = page.next_cursor ?? undefined;
    if (cursor !== undefined && cursors.has(cursor)) break;
    if (cursor !== undefined) cursors.add(cursor);
  } while (cursor !== undefined);
  return soonestFirst(jobs.filter(isActiveJob));
}

export const proJobsQueryOptions = (generation: number) =>
  queryOptions({
    queryKey: proJobsQueryKey(generation),
    queryFn: ({ signal }) => fetchActiveJobs(generation, signal),
    retry: false,
  });

export const proJobQueryOptions = (jobId: string, generation: number) =>
  queryOptions({
    queryKey: proJobQueryKey(jobId, generation),
    queryFn: ({ signal }) =>
      apiGet("/v1/pros/me/jobs/{job_id}", {
        auth: true,
        signal,
        generation,
        params: { job_id: jobId },
      }),
    retry: false,
  });

/**
 * "Your jobs" on the pro's home: asked for while a pro is signed in, and again when the home
 * comes back into focus or the app to the foreground. `refetch` asks nothing for anyone else
 * (TanStack's `refetch` runs even on a disabled query).
 */
export function useProJobs() {
  const generation = useSessionGeneration();
  const { status, user } = useSession();
  const enabled = status === "signedIn" && user?.role === "pro";
  const query = useQuery({ ...proJobsQueryOptions(generation), enabled });
  const { refetch: refetchQuery } = query;
  const refetch = useCallback(
    () => (enabled ? refetchQuery() : Promise.resolve()),
    [enabled, refetchQuery],
  );
  useRefetchOnReturn(refetch, enabled);
  return { ...query, refetch };
}

/**
 * One of the pro's jobs. It draws at once from "Your jobs" when the list holds it, then asks the
 * API (on open, on focus, on foreground). An id that is not a UUID asks nothing and reads as not
 * found, as the API would answer.
 */
export function useProJob(jobId: string) {
  const client = useQueryClient();
  const generation = useSessionGeneration();
  const signedIn = useSession().status === "signedIn";
  const valid = isUuid(jobId);
  const enabled = signedIn && valid;
  const query = useQuery({
    ...proJobQueryOptions(jobId, generation),
    enabled,
    initialData: () =>
      client.getQueryData<ProJob[]>(proJobsQueryKey(generation))?.find((job) => job.id === jobId),
    initialDataUpdatedAt: () => client.getQueryState(proJobsQueryKey(generation))?.dataUpdatedAt,
  });
  const { refetch: refetchQuery } = query;
  const refetch = useCallback(
    () => (enabled ? refetchQuery() : Promise.resolve()),
    [enabled, refetchQuery],
  );
  useRefetchOnReturn(refetch, enabled);
  return { ...query, refetch, valid };
}

/** No job of this pro with that id (404, as for anyone else's job). */
export const isJobGone = (error: unknown): boolean =>
  error instanceof ApiError && error.status === 404;

/**
 * The job as an action answered it, in place at once (the screen under a sheet redraws as the
 * sheet closes), and "Your jobs" asked again. Only for the session the action started in: after a
 * sign-out or another sign-in the answer goes nowhere.
 */
function applyJob(client: QueryClient, job: ProJob, generation: number): void {
  if (!isCurrentGeneration(generation)) return;
  client.setQueryData(proJobQueryKey(job.id, generation), job);
  void client.invalidateQueries({ queryKey: proJobsQueryKey(generation) });
}

/** The job and the list asked again: an action found the job moved on (409) or gone (404). */
export function refreshJob(client: QueryClient, jobId: string, generation: number): void {
  if (!isCurrentGeneration(generation)) return;
  void client.invalidateQueries({ queryKey: proJobQueryKey(jobId, generation) });
  void client.invalidateQueries({ queryKey: proJobsQueryKey(generation) });
}

/**
 * Why a step did not go through:
 * - `signedOut`: the session it started in is over; that session's screens are gone;
 * - `changed`: the job is no longer where the step starts (409), e.g. already on the way;
 * - `gone`: no such job of this pro any more (404);
 * - `offline`: no answer (network or timeout); trying again is safe;
 * - `failed`: anything else.
 */
export type StepFailure = "signedOut" | "changed" | "gone" | "offline" | "failed";

export function stepFailure(error: unknown): StepFailure {
  if (error instanceof SessionExpiredError) return "signedOut";
  if (error instanceof NetworkError) return "offline";
  if (error instanceof ApiError && error.status === 409) return "changed";
  if (error instanceof ApiError && error.status === 404) return "gone";
  return "failed";
}

/** "On my way" with an arrival time; on the way already, it changes only the time. */
export async function markOnTheWay(
  client: QueryClient,
  jobId: string,
  etaMinutes: number,
  generation: number,
): Promise<ProJob> {
  const job = await apiPost(
    "/v1/pros/me/jobs/{job_id}/on-the-way",
    { eta_minutes: etaMinutes },
    { auth: true, generation, params: { job_id: jobId } },
  );
  applyJob(client, job, generation);
  return job;
}

/** Work starts; the API refuses it (409 `check_in_required`) before a check-in. */
export async function startJob(
  client: QueryClient,
  jobId: string,
  generation: number,
): Promise<ProJob> {
  const job = await apiPost("/v1/pros/me/jobs/{job_id}/start", undefined, {
    auth: true,
    generation,
    params: { job_id: jobId },
  });
  applyJob(client, job, generation);
  return job;
}

/**
 * How a check-in ended: `checkedIn`; `wrongCode` with the tries left (from the API's
 * `Arrival-Code-Attempts-Remaining` header, null if it sent none); `locked` (too many wrong codes:
 * no retry, support resolves it); or why the step failed otherwise.
 */
export type CheckInOutcome =
  | { kind: "checkedIn"; job: ProJob }
  | { kind: "wrongCode"; triesLeft: number | null }
  | { kind: "locked" }
  | { kind: "failure"; failure: StepFailure };

export const ATTEMPTS_REMAINING_HEADER = "Arrival-Code-Attempts-Remaining";
const ARRIVAL_CODE_INVALID = "arrival_code_invalid";
const ARRIVAL_CODE_LOCKED = 423;

function triesLeft(error: ApiError): number | null {
  const raw = error.header(ATTEMPTS_REMAINING_HEADER);
  const value = raw === null || !/^\d+$/.test(raw.trim()) ? Number.NaN : Number(raw);
  return Number.isSafeInteger(value) ? value : null;
}

/**
 * Checks in with the customer's arrival code and where the pro is. The code and the position go
 * into this one request and nowhere else: never into state, a cache or a log. A locked check-in
 * (423) also refreshes the job, so the screen under the sheet shows it.
 */
export async function checkIn(
  client: QueryClient,
  jobId: string,
  arrivalCode: string,
  position: CheckInPosition,
  generation: number,
): Promise<CheckInOutcome> {
  try {
    const job = await apiPost(
      "/v1/pros/me/jobs/{job_id}/check-in",
      { arrival_code: arrivalCode, lat: position.lat, lng: position.lng },
      { auth: true, generation, params: { job_id: jobId } },
    );
    applyJob(client, job, generation);
    return { kind: "checkedIn", job };
  } catch (error) {
    if (error instanceof ApiError && error.code === ARRIVAL_CODE_INVALID) {
      return { kind: "wrongCode", triesLeft: triesLeft(error) };
    }
    if (error instanceof ApiError && error.status === ARRIVAL_CODE_LOCKED) {
      refreshJob(client, jobId, generation);
      return { kind: "locked" };
    }
    const failure = stepFailure(error);
    if (failure === "changed" || failure === "gone") refreshJob(client, jobId, generation);
    return { kind: "failure", failure };
  }
}

/**
 * Runs one action at a time, however fast the taps: a second call while one is in flight is
 * ignored (`undefined`). `busy` drives the button's spinner; `mounted` tells the caller whether
 * its screen is still there to show the answer.
 */
export function useSingleFlight() {
  const inFlight = useRef(false);
  const mounted = useRef(true);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const run = useCallback(async <T>(work: () => Promise<T>): Promise<T | undefined> => {
    if (inFlight.current) return undefined;
    inFlight.current = true;
    setBusy(true);
    try {
      return await work();
    } finally {
      inFlight.current = false;
      if (mounted.current) setBusy(false);
    }
  }, []);

  return { busy, run, mounted };
}
