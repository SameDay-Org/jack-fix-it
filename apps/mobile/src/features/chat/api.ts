import { queryOptions, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useIsFocused } from "expo-router";
import { useCallback, useRef, useState } from "react";

import { apiGet, apiPost, isCurrentGeneration, useSession, useSessionGeneration } from "@/api";
import { useInForeground } from "@/features/jobs/api";
import { useRefetchOnReturn } from "@/features/quotes/useRequestQuotes";

import { chatConfig } from "./config";
import { addSent, appendOlder, mergeNewest, type ChatMessage, type Thread } from "./thread";

type ChatHref = {
  pathname: "/jobs/[id]/chat";
  params: { id: string; request?: string };
};

/**
 * The chat of one job. A customer passes the request the job belongs to: the chat reads the pro's
 * name and whether the chat is closed from the job view the customer already holds.
 */
export const chatHref = (jobId: string, requestId?: string): ChatHref => ({
  pathname: "/jobs/[id]/chat",
  params: requestId === undefined ? { id: jobId } : { id: jobId, request: requestId },
});

/**
 * One job's thread as the session that opened it sees it: the generation is part of the key and
 * pins every call, so an answer for a session that is gone never lands where the next one reads.
 */
export const chatQueryKey = (jobId: string, generation: number) =>
  ["chat", jobId, generation] as const;

const held = (client: QueryClient, jobId: string, generation: number): Thread | undefined =>
  client.getQueryData<Thread>(chatQueryKey(jobId, generation));

/**
 * The newest page, folded into the messages already held (`mergeNewest`): asked when the chat
 * opens and again on every poll. The page size is the API's own default.
 */
export const chatQueryOptions = (client: QueryClient, jobId: string, generation: number) =>
  queryOptions({
    queryKey: chatQueryKey(jobId, generation),
    queryFn: async ({ signal }): Promise<Thread> => {
      const page = await apiGet("/v1/jobs/{job_id}/messages", {
        auth: true,
        signal,
        generation,
        params: { job_id: jobId },
      });
      return mergeNewest(held(client, jobId, generation), page);
    },
    retry: false,
  });

/**
 * The chat, kept fresh without live updates (#73 is not built): asked when it opens, again when
 * the screen comes back into focus or the app to the foreground, and every `chatConfig.pollMs`
 * while the screen is focused and the app in the foreground. A blur, the background or a sign-out
 * stops the asking: the signed-out shell unmounts the screen, and a key from a signed-out session
 * is never enabled.
 */
export function useChat(jobId: string, { enabled = true } = {}) {
  const client = useQueryClient();
  const generation = useSessionGeneration();
  const signedIn = useSession().status === "signedIn";
  const focused = useIsFocused();
  const foreground = useInForeground();
  const live = enabled && signedIn;
  const query = useQuery({
    ...chatQueryOptions(client, jobId, generation),
    enabled: live,
    refetchInterval: live && focused && foreground ? chatConfig.pollMs : false,
  });
  const { refetch: refetchQuery } = query;
  // `refetch` runs even on a disabled query: nothing is asked for a signed-out session.
  const refetch = useCallback(
    () => (live ? refetchQuery() : Promise.resolve()),
    [live, refetchQuery],
  );
  useRefetchOnReturn(refetch, live);
  return { ...query, refetch, generation };
}

export type OlderState = "idle" | "loading" | "failed";

/**
 * The messages before the oldest one held, a page at a time through the thread's cursor. A page
 * lands only in the thread it was asked for: after a sign-out, another sign-in, or a poll that
 * started the thread over (its cursor moved), the answer goes nowhere.
 */
export function useOlderMessages(jobId: string, generation: number) {
  const client = useQueryClient();
  const [state, setState] = useState<OlderState>("idle");
  const loading = useRef(false);

  const load = useCallback(async () => {
    const cursor = held(client, jobId, generation)?.olderCursor;
    if (loading.current || !cursor) return;
    loading.current = true;
    setState("loading");
    try {
      const page = await apiGet("/v1/jobs/{job_id}/messages", {
        auth: true,
        generation,
        params: { job_id: jobId },
        query: { cursor },
      });
      const current = held(client, jobId, generation);
      if (isCurrentGeneration(generation) && current?.olderCursor === cursor) {
        client.setQueryData(chatQueryKey(jobId, generation), appendOlder(current, page));
      }
      setState("idle");
    } catch {
      setState("failed");
    } finally {
      loading.current = false;
    }
  }, [client, generation, jobId]);

  return { state, load };
}

/**
 * Sends one message for the session it was typed in. The stored message (masked where it showed
 * contact details) goes into the thread at once; a poll in flight is cancelled first, so an answer
 * asked before the message was stored never draws over it.
 */
export async function sendMessage(
  client: QueryClient,
  jobId: string,
  body: string,
  generation: number,
): Promise<ChatMessage> {
  const message = await apiPost(
    "/v1/jobs/{job_id}/messages",
    { body },
    { auth: true, generation, params: { job_id: jobId } },
  );
  if (isCurrentGeneration(generation)) {
    const key = chatQueryKey(jobId, generation);
    await client.cancelQueries({ queryKey: key });
    if (isCurrentGeneration(generation)) {
      client.setQueryData<Thread>(key, (thread) => (thread ? addSent(thread, message) : thread));
    }
  }
  return message;
}

/**
 * Moves the caller's read marker up to `upTo` (the API only moves it forward) and returns the
 * unread count the API answers with; the thread takes it at once, for the session that asked.
 */
export async function markRead(
  client: QueryClient,
  jobId: string,
  upTo: string,
  generation: number,
): Promise<number> {
  const { unread_count: unread } = await apiPost(
    "/v1/jobs/{job_id}/messages/read",
    { up_to: upTo },
    { auth: true, generation, params: { job_id: jobId } },
  );
  if (isCurrentGeneration(generation)) {
    client.setQueryData<Thread>(chatQueryKey(jobId, generation), (thread) =>
      thread ? { ...thread, unreadCount: unread } : thread,
    );
  }
  return unread;
}
