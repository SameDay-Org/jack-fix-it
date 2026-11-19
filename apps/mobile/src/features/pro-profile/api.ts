import { queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  ApiError,
  apiGet,
  apiPatch,
  NetworkError,
  useSession,
  useSessionGeneration,
  type GetResponse,
  type PatchBody,
} from "@/api";

import { proProfileConfig } from "./config";

/** The pro's own profile (GET /v1/pros/me). */
export type ProProfile = GetResponse<"/v1/pros/me">;
/** PATCH /v1/pros/me: the fields to change; the two id lists replace their whole set. */
export type ProProfileUpdate = PatchBody<"/v1/pros/me">;
/** The served areas: region, then city, then ZIP. */
export type ServiceRegion = GetResponse<"/v1/service-areas">[number];
export type ServiceCity = ServiceRegion["cities"][number];

/**
 * The profile as the session that asked for it sees it: the generation is part of the key and
 * pins every call, so an answer for a session that is gone never lands where the next one reads.
 */
export const myProProfileQueryKey = (generation: number) => ["pro-profile", generation] as const;

export const myProProfileQueryOptions = (generation: number) =>
  queryOptions({
    queryKey: myProProfileQueryKey(generation),
    queryFn: ({ signal }): Promise<ProProfile> =>
      apiGet("/v1/pros/me", { auth: true, signal, generation }),
    retry: false,
  });

/**
 * The signed-in pro's profile; the first read creates an empty one, pending verification. Asked
 * for only while a pro is signed in. A failure is shown with a retry, not retried in silence.
 * `pollWhilePending`: asked again every `proProfileConfig.reviewPollMs` while the review is
 * pending (the pro's home, focused and in the foreground: #476), since no push says it is done.
 */
export function useMyProProfile({ pollWhilePending = false } = {}) {
  const generation = useSessionGeneration();
  const { status, user } = useSession();
  const enabled = status === "signedIn" && user?.role === "pro";
  return useQuery({
    ...myProProfileQueryOptions(generation),
    enabled,
    refetchInterval: (current) =>
      enabled && pollWhilePending && current.state.data?.verification_status === "pending"
        ? proProfileConfig.reviewPollMs
        : false,
  });
}

/** The fields to change, for the session the form was sent in. */
export type ProProfileUpdateVariables = { body: ProProfileUpdate; generation: number };

/** Edits the profile (PATCH /v1/pros/me); the cached profile becomes the server's answer. */
export function useUpdateProProfile() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ body, generation }: ProProfileUpdateVariables) =>
      apiPatch("/v1/pros/me", body, { auth: true, generation }),
    onSuccess: (profile, { generation }) =>
      client.setQueryData(myProProfileQueryKey(generation), profile),
  });
}

export const SERVICE_AREAS_QUERY_KEY = ["service-areas"] as const;

/**
 * The active service areas, as the API groups them. Like the categories, the list only changes
 * by a staff edit: one load serves the session, and a failure is shown with a retry (the
 * endpoint is rate limited per IP).
 */
export const useServiceAreas = () =>
  useQuery({
    queryKey: SERVICE_AREAS_QUERY_KEY,
    queryFn: ({ signal }) => apiGet("/v1/service-areas", { signal }),
    staleTime: Infinity,
    retry: false,
  });

/**
 * Why a save did not go through:
 * - `offline`: no answer (no connection, or a timeout);
 * - `photo`: the API refused the new photo (`invalid_media`);
 * - `choices`: a category or a ZIP code is no longer offered (`invalid_category`,
 *   `invalid_service_area`);
 * - `generic`: anything else (another 4xx, a 5xx).
 */
export type ProfileFailure = "offline" | "photo" | "choices" | "generic";

const REFUSALS: Record<string, ProfileFailure> = {
  invalid_media: "photo",
  invalid_category: "choices",
  invalid_service_area: "choices",
};

export function profileFailure(error: unknown): ProfileFailure {
  if (error instanceof NetworkError) return "offline";
  if (!(error instanceof ApiError) || error.status !== 422 || !error.code) return "generic";
  return REFUSALS[error.code] ?? "generic";
}
