import { useMutation } from "@tanstack/react-query";
import { useCallback, useRef } from "react";

import { apiPost, type PostResponse } from "@/api";

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
  const mutation = useMutation({
    mutationFn: (body: RequestCreate) => apiPost("/v1/requests", body, { auth: true }),
  });
  const { mutateAsync } = mutation;
  const busy = useRef(false);

  const send = useCallback(
    async (body: RequestCreate, { onSent, onFailed }: SendCallbacks) => {
      if (busy.current) return;
      busy.current = true;
      let created: CreatedRequest;
      try {
        created = await mutateAsync(body);
      } catch (error) {
        busy.current = false;
        onFailed(sendFailureOf(error));
        return;
      }
      onSent(created);
    },
    [mutateAsync],
  );

  return { send, sending: mutation.isPending || mutation.isSuccess };
}
