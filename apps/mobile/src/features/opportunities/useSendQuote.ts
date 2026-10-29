import type { ApiSchema } from "@jack/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback, useRef } from "react";

import { apiPost, ApiError, SessionExpiredError } from "@/api";

import type { QuoteCreate } from "./quoteDraft";
import { forgetOpportunity } from "./useOpportunity";

export type SentQuote = ApiSchema<"QuoteOut">;

/**
 * How a send ended, for the form: `gone` (404, or 409 `not_quotable`: the opportunity was
 * declined, expired or closed), `alreadyQuoted` (409 `quote_exists`), `invalid` (422: a field
 * the app could not check, a platform cap), `signedOut` (the session ended; its own screens take
 * over), `failed` (offline, timeout, 503 or any other answer; safe to send again).
 */
export type SendFailure = "gone" | "alreadyQuoted" | "invalid" | "signedOut" | "failed";

const QUOTE_EXISTS = "quote_exists";

export function sendFailureOf(error: unknown): SendFailure {
  if (error instanceof SessionExpiredError) return "signedOut";
  if (error instanceof ApiError) {
    if (error.status === 404) return "gone";
    if (error.status === 409) return error.code === QUOTE_EXISTS ? "alreadyQuoted" : "gone";
    if (error.status === 422) return "invalid";
  }
  return "failed";
}

type SendCallbacks = {
  onSent: (quote: SentQuote) => void;
  onFailed: (failure: SendFailure) => void;
};

/**
 * Sends the pro's quote for one opportunity. A quoted dispatch is no longer the pro's
 * opportunity (its detail answers 404), so a 201, like a 404 or a 409, forgets it: the row leaves
 * the pro's list at once and the detail leaves the cache. A second call while one is in flight is
 * ignored, however fast the taps, so one press sends one POST.
 */
export function useSendQuote(dispatchId: string) {
  const client = useQueryClient();
  const inFlight = useRef(false);
  // The cache work lives on the mutation, so it happens even when the form closed before the
  // answer; the form's own callbacks (below) run only while it is mounted.
  const mutation = useMutation({
    mutationFn: (body: QuoteCreate) =>
      apiPost("/v1/pros/me/opportunities/{dispatch_id}/quote", body, {
        auth: true,
        params: { dispatch_id: dispatchId },
      }),
    onSuccess: () => forgetOpportunity(client, dispatchId),
    onError: async (error) => {
      const failure = sendFailureOf(error);
      if (failure === "gone" || failure === "alreadyQuoted") {
        await forgetOpportunity(client, dispatchId);
      }
    },
    onSettled: () => {
      inFlight.current = false;
    },
  });
  const { mutate } = mutation;

  const send = useCallback(
    (body: QuoteCreate, { onSent, onFailed }: SendCallbacks) => {
      if (inFlight.current) return;
      inFlight.current = true;
      mutate(body, {
        onSuccess: (quote) => onSent(quote),
        onError: (error) => onFailed(sendFailureOf(error)),
      });
    },
    [mutate],
  );

  return { send, sending: mutation.isPending };
}
