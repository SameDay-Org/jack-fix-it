import type { ApiSchema } from "@jack/shared";
import { queryOptions, useQuery, useQueryClient } from "@tanstack/react-query";
import { useIsFocused } from "expo-router";
import { useEffect, useState } from "react";

import { apiGet, ApiError, useSession, useSessionGeneration } from "@/api";

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
    // Never fresh: the query asks again each time it is enabled again (the screen or app is back).
    staleTime: 0,
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
    staleTime: 0,
  });

// The API's definitive "no": not this customer's job (403), no such job (404), or the pro is
// not on the way any more (409). Anything else (offline, 5xx) is worth another try.
const REFUSALS: readonly number[] = [403, 404, 409];
const isRefusal = (error: unknown): boolean =>
  error instanceof ApiError && REFUSALS.includes(error.status);

/**
 * The pro's position and route while the live map is watched. `active` is the one condition for
 * all tracking work, the requests here and the map's animation alike: `enabled` (the job is on
 * the way and there is a map), signed in, the screen focused and the app in the foreground.
 * While it holds, both are asked for at once and every `liveMapConfig.pollMs`; while it does not,
 * nothing is asked for (mounting out of focus starts no request), and both are asked for again
 * the moment it holds again.
 *
 * A refusal of either (`REFUSALS`) ends the tracking for as long as this map is mounted:
 * `refused` turns true, nothing more is asked for, and what the cache held of the pro's position
 * and route is removed, so no screen can draw them again. A map mounted later asks once more.
 */
export function useLiveTracking(jobId: string, enabled: boolean) {
  const client = useQueryClient();
  const generation = useSessionGeneration();
  const signedIn = useSession().status === "signedIn";
  const focused = useIsFocused();
  const foreground = useInForeground();
  const scope = `${jobId}:${generation}`;
  const [refusedIn, setRefusedIn] = useState<string | null>(null);
  const refused = refusedIn === scope;
  const active = enabled && signedIn && focused && foreground && !refused;
  const refetchInterval = active ? liveMapConfig.pollMs : false;

  const position = useQuery({
    ...proLocationQueryOptions(jobId, generation),
    enabled: active,
    refetchInterval,
  });
  const route = useQuery({
    ...jobRouteQueryOptions(jobId, generation),
    enabled: active,
    refetchInterval,
  });
  if (!refused && (isRefusal(position.error) || isRefusal(route.error))) setRefusedIn(scope);
  useEffect(() => {
    if (!refused) return;
    client.removeQueries({ queryKey: proLocationQueryKey(jobId, generation), exact: true });
    client.removeQueries({ queryKey: jobRouteQueryKey(jobId, generation), exact: true });
  }, [client, generation, jobId, refused]);
  return { position, route, active, refused };
}
