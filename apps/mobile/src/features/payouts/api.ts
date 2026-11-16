import { queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect } from "react";

import {
  ApiError,
  apiGet,
  apiPost,
  NetworkError,
  useSession,
  useSessionGeneration,
  type GetResponse,
} from "@/api";
import { myProProfileQueryKey, type ProProfile } from "@/features/pro-profile/api";
import { useRefetchOnReturn } from "@/features/quotes/useRequestQuotes";

/** Where the pro's payout setup stands (GET /v1/pros/me/payouts). */
export type Payouts = GetResponse<"/v1/pros/me/payouts">;
/** `not_started`, `incomplete`, `in_review` or `enabled`. */
export type PayoutsStatus = Payouts["status"];

/**
 * The payout status as the session that asked for it sees it: the generation is part of the key
 * and pins every call.
 */
export const payoutsQueryKey = (generation: number) => ["pro-payouts", generation] as const;

export const payoutsQueryOptions = (generation: number) =>
  queryOptions({
    queryKey: payoutsQueryKey(generation),
    queryFn: ({ signal }): Promise<Payouts> =>
      apiGet("/v1/pros/me/payouts", { auth: true, signal, generation }),
    retry: false,
  });

/**
 * The signed-in pro's payout status. The API reads it from Stripe on every call, so only the
 * payout screen asks: when it opens, each time it comes back into focus, and when the app
 * returns to the foreground while it is open (the setup page is a browser over the app). Callers
 * that ask together (the foreground, the browser's return, the return link) share one request.
 *
 * The same call stores `payouts_enabled` on the pro's profile, so a cached profile that says
 * otherwise is asked for again: that is what lets the home list requests once payouts are on.
 */
export function usePayoutsStatus() {
  const client = useQueryClient();
  const generation = useSessionGeneration();
  const { status, user } = useSession();
  const enabled = status === "signedIn" && user?.role === "pro";
  const query = useQuery({ ...payoutsQueryOptions(generation), enabled });
  const { refetch: refetchQuery } = query;
  const refetch = useCallback(
    () => (enabled ? refetchQuery({ cancelRefetch: false }) : Promise.resolve()),
    [enabled, refetchQuery],
  );
  useRefetchOnReturn(refetch, enabled);

  const payoutsEnabled = query.data?.payouts_enabled;
  useEffect(() => {
    if (payoutsEnabled === undefined) return;
    const profileKey = myProProfileQueryKey(generation);
    const profile = client.getQueryData<ProProfile>(profileKey);
    if (profile?.payouts_enabled !== payoutsEnabled) {
      void client.invalidateQueries({ queryKey: profileKey });
    }
  }, [client, generation, payoutsEnabled]);

  return { ...query, refetch };
}

/**
 * A setup link to ask for: for the session the button was pressed in, and only while the screen
 * that asked is still there (`signal`).
 */
export type OnboardingLinkVariables = { generation: number; signal: AbortSignal };

/**
 * Asks for a link to Stripe's hosted payout setup (POST) and hands it to `open` at once. The
 * link is single-use and a way into the pro's payout account, so it exists in that one call
 * only: what the mutation keeps is its variables, what `open` returned and its error (whose
 * classes never quote the link: `SetupPageError`, `SetupLeftError`, the API's), never the link. No
 * query holds it and nothing logs it. A screen that was left before the link arrived opens
 * nothing: the request is cancelled, and a link that still arrives is dropped.
 *
 * A status request already under way is cancelled before the page opens (its answer would
 * predate the setup). Once the page is closed, however it was left, the status is asked for
 * again, and the mutation stays pending until that answer is in: the screen never shows the old
 * status in between.
 */
export function useCreateOnboardingLink<Result>(open: (url: string) => Promise<Result>) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async ({ generation, signal }: OnboardingLinkVariables): Promise<Result> => {
      const { url } = await apiPost("/v1/pros/me/payouts/onboarding-link", undefined, {
        auth: true,
        generation,
        signal,
      });
      await client.cancelQueries({ queryKey: payoutsQueryKey(generation) });
      if (signal.aborted) throw new SetupLeftError();
      return open(url);
    },
    onSuccess: (_result, { generation }) =>
      client.invalidateQueries({ queryKey: payoutsQueryKey(generation) }, { cancelRefetch: false }),
  });
}

/** The screen that asked for a setup link was left before the link could be opened. */
export class SetupLeftError extends Error {
  constructor() {
    super("The payout screen was left before the setup page opened");
    this.name = "SetupLeftError";
  }
}

/**
 * Why something about payouts did not go through:
 * - `offline`: no answer (no connection, or a timeout);
 * - `busy`: too many setup links asked for in a row (429);
 * - `review`: the payout account needs support before it can go on (409 `payouts_needs_review`);
 * - `unavailable`: payments are down or Stripe refused the call (502, 503);
 * - `generic`: anything else, the browser that would not open included.
 */
export type PayoutsFailure = "offline" | "busy" | "review" | "unavailable" | "generic";

const UNAVAILABLE = [502, 503];

export function payoutsFailure(error: unknown): PayoutsFailure {
  if (error instanceof NetworkError) return "offline";
  if (!(error instanceof ApiError)) return "generic";
  if (error.status === 429) return "busy";
  if (error.status === 409 && error.code === "payouts_needs_review") return "review";
  return UNAVAILABLE.includes(error.status) ? "unavailable" : "generic";
}
