import type { ApiSchema } from "@jack/shared";
import { queryOptions, useQuery } from "@tanstack/react-query";
import { useIsFocused } from "expo-router";

import { apiGet, ApiError, useSession, useSessionGeneration } from "@/api";
import { useRefetchOnReturn } from "@/features/quotes/useRequestQuotes";

import { useInForeground } from "../api";

import { liveMapConfig } from "./config";

export type ProPosition = ApiSchema<"ProPosition">;
export type JobRoute = ApiSchema<"JobRoute">;

export const proLocationQueryKey = (jobId: string, generation: number) =>
  ["job-pro-location", jobId, generation] as const;
export const jobRouteQueryKey = (jobId: string, generation: number) =>
  ["job-route", jobId, generation] as const;

/** The pro's latest position on the way (#350); null while there is none to show. */
const proLocationQueryOptions = (jobId: string, generation: number) =>
  queryOptions({
    queryKey: proLocationQueryKey(jobId, generation),
    queryFn: async ({ signal }) => {
      const { position } = await apiGet("/v1/jobs/{job_id}/pro-location", {
        auth: true,
        signal,
        generation,
        params: { job_id: jobId },
      });
      return position;
    },
    retry: false,
  });

/**
 * The pro's route to the job's address (#351); null while there is none, and when the route
 * provider is down (503 `route_unavailable`): the map still shows the pro, and the cards fall back
 * to the arrival time the pro gave.
 */
const jobRouteQueryOptions = (jobId: string, generation: number) =>
  queryOptions({
    queryKey: jobRouteQueryKey(jobId, generation),
    queryFn: async ({ signal }) => {
      try {
        const { route } = await apiGet("/v1/jobs/{job_id}/route", {
          auth: true,
          signal,
          generation,
          params: { job_id: jobId },
        });
        return route;
      } catch (error) {
        if (error instanceof ApiError && error.status === 503) return null;
        throw error;
      }
    },
    retry: false,
  });

/**
 * The pro's position and route while the live map is up: asked for when the map mounts, again
 * when the screen comes back into focus or the app to the foreground, and every
 * `liveMapConfig.pollMs` while the screen is focused and the app in the foreground. Nothing is
 * asked for while `enabled` is false (the job is not on the way, or there is no map) or signed out.
 */
export function useLiveTracking(jobId: string, enabled: boolean) {
  const generation = useSessionGeneration();
  const signedIn = useSession().status === "signedIn";
  const focused = useIsFocused();
  const foreground = useInForeground();
  const live = enabled && signedIn;
  const refetchInterval = live && focused && foreground ? liveMapConfig.pollMs : false;

  const position = useQuery({
    ...proLocationQueryOptions(jobId, generation),
    enabled: live,
    refetchInterval,
  });
  const route = useQuery({
    ...jobRouteQueryOptions(jobId, generation),
    enabled: live,
    refetchInterval,
  });
  useRefetchOnReturn(position.refetch, live);
  useRefetchOnReturn(route.refetch, live);
  return { position, route };
}
