import { useQueryClient } from "@tanstack/react-query";
import { useFocusEffect, useIsFocused } from "expo-router";
import { useCallback, useEffect, useRef } from "react";

import { useInForeground } from "@/features/jobs/api";

import { markRead } from "./api";
import type { Thread } from "./thread";

/**
 * Marks the chat read up to its newest message while the screen is focused and the app in the
 * foreground, each time new messages arrive and the API counts some unread. One mark per newest
 * message: a failed mark waits for the next message or the next focus rather than repeating on
 * every poll. `onUnread` hears the count the API answers with (the job views show it).
 */
export function useReadMarker(
  jobId: string,
  generation: number,
  thread: Thread | undefined,
  onUnread: (count: number) => void,
): void {
  const client = useQueryClient();
  const focused = useIsFocused();
  const foreground = useInForeground();
  const marked = useRef<string | null>(null);
  const newest = thread?.messages[0]?.id;
  const unread = thread?.unreadCount ?? 0;

  // Back in focus, the newest message is marked again if the API still counts it unread.
  useFocusEffect(
    useCallback(() => {
      marked.current = null;
    }, []),
  );

  useEffect(() => {
    if (!focused || !foreground || newest === undefined || unread === 0) return;
    if (marked.current === newest) return;
    marked.current = newest;
    markRead(client, jobId, newest, generation).then(onUnread, () => undefined);
  }, [client, focused, foreground, generation, jobId, newest, onUnread, unread]);
}
