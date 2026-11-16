import { queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";

import {
  ApiError,
  apiGet,
  apiPost,
  NetworkError,
  useSession,
  useSessionGeneration,
  type PostBody,
} from "@/api";
import { useRefetchOnReturn } from "@/features/quotes/useRequestQuotes";

import { withSubmitted, type MyDocuments } from "./documents";

/** POST /v1/pros/me/documents: the type, the upload's key and, when given, the expiry date. */
export type DocumentSubmission = PostBody<"/v1/pros/me/documents">;

/**
 * The pro's documents as the session that asked for them sees them: the generation is part of
 * the key and pins every call. The answer carries presigned URLs: it lives in the cache and on
 * the screen only, never in a log.
 */
export const myDocumentsQueryKey = (generation: number) => ["pro-documents", generation] as const;

export const myDocumentsQueryOptions = (generation: number) =>
  queryOptions({
    queryKey: myDocumentsQueryKey(generation),
    queryFn: ({ signal }): Promise<MyDocuments> =>
      apiGet("/v1/pros/me/documents", { auth: true, signal, generation }),
    retry: false,
  });

/**
 * The signed-in pro's verification documents: asked for while a pro is signed in, and again each
 * time the screen comes back into focus or the app to the foreground (a review may have landed,
 * and the URLs are signed for a few minutes only). A failure shows with a retry.
 */
export function useMyDocuments() {
  const generation = useSessionGeneration();
  const { status, user } = useSession();
  const enabled = status === "signedIn" && user?.role === "pro";
  const query = useQuery({ ...myDocumentsQueryOptions(generation), enabled });
  const { refetch: refetchQuery } = query;
  const refetch = useCallback(
    () => (enabled ? refetchQuery() : Promise.resolve()),
    [enabled, refetchQuery],
  );
  useRefetchOnReturn(refetch, enabled);
  return { ...query, refetch };
}

/** A document to submit, for the session the button was pressed in. */
export type SubmitDocumentVariables = { body: DocumentSubmission; generation: number };

/**
 * Submits a document for review (POST). A pending one of the same type is replaced by the
 * server. The cached list shows the new document at once, and is asked for again after every
 * submission, accepted or not.
 */
export function useSubmitDocument() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ body, generation }: SubmitDocumentVariables) =>
      apiPost("/v1/pros/me/documents", body, { auth: true, generation }),
    onSuccess: (document, { generation }) =>
      client.setQueryData<MyDocuments>(
        myDocumentsQueryKey(generation),
        (data) => data && withSubmitted(data, document),
      ),
    // Asked again whatever the answer: a submission whose answer was lost may have gone through
    // (its retry is then refused, the key being a document already), and the list says which.
    onSettled: (_document, _error, { generation }) =>
      void client.invalidateQueries({ queryKey: myDocumentsQueryKey(generation) }),
  });
}

/**
 * Why a document was not submitted:
 * - `offline`: no answer (no connection, or a timeout);
 * - `photo`: the API refused the photo (`invalid_media`: not this pro's upload, or already used);
 * - `generic`: anything else (another 4xx, a 5xx).
 */
export type DocumentFailure = "offline" | "photo" | "generic";

export function documentFailure(error: unknown): DocumentFailure {
  if (error instanceof NetworkError) return "offline";
  const refused =
    error instanceof ApiError && error.status === 422 && error.code === "invalid_media";
  return refused ? "photo" : "generic";
}
