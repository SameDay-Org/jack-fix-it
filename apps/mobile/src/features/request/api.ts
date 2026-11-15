import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback, useRef } from "react";

import { apiPost, isCurrentGeneration, sessionGeneration, type PostResponse } from "@/api";
import { invalidateMyRequests } from "@/features/history/useMyRequests";

import { keyReused, sendFailureOf, type RequestCreate, type SendFailure } from "./send";
import { releaseSendKey, sendKeyFor } from "./sendKey";

export type CreatedRequest = PostResponse<"/v1/requests">;

export type SendCallbacks = {
  onSent: (request: CreatedRequest) => void;
  onFailed: (failure: SendFailure) => void;
};

/**
 * Sends the request once. A second call while one is in flight, or after one went through, is
 * ignored however fast the taps: the server would create a second request.
 */
/** Sends the request; the callbacks say how it ended. A call while one is in flight is ignored. */
export type SendRequest = (body: RequestCreate, callbacks: SendCallbacks) => Promise<void>;

type Attempt = { body: RequestCreate; idempotencyKey: string };

/**
 * Every try carries the draft's Idempotency-Key (`sendKey.ts`): a retry of the same body answers
 * the request the first try made (200, handled like the 201) instead of creating a second one.
 */
export function useSendRequest(): { send: SendRequest; sending: boolean } {
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: ({ body, idempotencyKey }: Attempt) =>
      apiPost("/v1/requests", body, { auth: true, idempotencyKey }),
  });
  const { mutateAsync } = mutation;
  const busy = useRef(false);

  const send = useCallback(
    async (body: RequestCreate, { onSent, onFailed }: SendCallbacks) => {
      if (busy.current) return;
      busy.current = true;
      // The answer belongs to the session the send started in. One that lands after a sign-out
      // or another sign-in is dropped: its confirmation or refusal would outlive that session.
      const startedIn = sessionGeneration();
      const idempotencyKey = sendKeyFor(body);
      if (idempotencyKey === null) {
        // No valid key could be made: nothing goes out (a malformed key would only be refused).
        busy.current = false;
        onFailed({ kind: "retry", reason: "failed" });
        return;
      }
      let created: CreatedRequest;
      try {
        created = await mutateAsync({ body, idempotencyKey });
      } catch (error) {
        busy.current = false;
        // The server holds this key for another body: the next try (Try again) takes a new one.
        // Nothing is sent again by itself.
        if (keyReused(error)) releaseSendKey(idempotencyKey);
        if (isCurrentGeneration(startedIn)) onFailed(sendFailureOf(error));
        return;
      }
      // The request exists: the key has done its job.
      releaseSendKey(idempotencyKey);
      if (!isCurrentGeneration(startedIn)) return;
      // History lists the new request the next time it shows (#47).
      void invalidateMyRequests(queryClient);
      onSent(created);
    },
    [mutateAsync, queryClient],
  );

  return { send, sending: mutation.isPending || mutation.isSuccess };
}
