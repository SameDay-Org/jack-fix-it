import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback, useRef } from "react";

import { apiPost, isCurrentGeneration, sessionGeneration, type PostResponse } from "@/api";
import { invalidateMyRequests } from "@/features/history/useMyRequests";

import { sendFailureOf, type RequestCreate, type SendFailure } from "./send";

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

export function useSendRequest(): { send: SendRequest; sending: boolean } {
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: (body: RequestCreate) => apiPost("/v1/requests", body, { auth: true }),
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
      let created: CreatedRequest;
      try {
        created = await mutateAsync(body);
      } catch (error) {
        busy.current = false;
        if (isCurrentGeneration(startedIn)) onFailed(sendFailureOf(error));
        return;
      }
      if (!isCurrentGeneration(startedIn)) return;
      // History lists the new request the next time it shows (#47).
      void invalidateMyRequests(queryClient);
      onSent(created);
    },
    [mutateAsync, queryClient],
  );

  return { send, sending: mutation.isPending || mutation.isSuccess };
}
