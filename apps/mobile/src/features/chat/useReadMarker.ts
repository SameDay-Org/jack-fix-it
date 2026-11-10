import { useQueryClient } from "@tanstack/react-query";
import { useFocusEffect, useIsFocused } from "expo-router";
import { useCallback, useEffect, useRef } from "react";

import { useInForeground } from "@/features/jobs/api";

import { markRead } from "./api";
import type { Thread } from "./thread";

/**
 * Where the newest of the `unread` messages from the other side sits in `messages` (newest
 * first), as far back as an unread one can be: the API counts unread the other side's messages
 * after the marker. -1 when nothing counts unread.
 */
function oldestUnreadIndex(messages: Thread["messages"], unread: number): number {
  if (unread <= 0) return -1;
  let counted = 0;
  for (let index = 0; index < messages.length; index += 1) {
    if (messages[index]?.sender !== "me") counted += 1;
    if (counted === unread) return index;
  }
  return messages.length - 1;
}

/**
 * Marks the chat read up to the newest message on screen (`newestVisible`, from the list's
 * viewability, #74 round 1): a message that arrives below while the reader is up in the history
 * is marked only once it is scrolled into view. Only while the screen is focused and the app in
 * the foreground, and only when what is on screen could be unread. The marker never moves back:
 * one mark per newer message; a failed mark waits for a newer one or the next focus rather than
 * repeating on every poll. `onUnread` hears the count the API answers with (the job views show
 * it).
 */
export function useReadMarker(
  jobId: string,
  generation: number,
  thread: Thread | undefined,
  newestVisible: string | undefined,
  onUnread: (count: number) => void,
): void {
  const client = useQueryClient();
  const focused = useIsFocused();
  const foreground = useInForeground();
  // The last message marked, for the session generation that marked it.
  const marked = useRef<{ generation: number; id: string } | null>(null);
  const messages = thread?.messages;
  const unread = thread?.unreadCount ?? 0;

  // Back in focus, what is on screen is marked again if the API still counts it unread.
  useFocusEffect(
    useCallback(() => {
      marked.current = null;
    }, []),
  );

  useEffect(() => {
    if (!focused || !foreground || !messages || newestVisible === undefined) return;
    const seen = messages.findIndex(({ id }) => id === newestVisible);
    // Not in this session's thread, or older than every message counted unread.
    if (seen === -1 || seen > oldestUnreadIndex(messages, unread)) return;
    // Another session's mark says nothing about this one's (the next account's marker is its own).
    if (marked.current !== null && marked.current.generation === generation) {
      const last = marked.current.id;
      const done = messages.findIndex(({ id }) => id === last);
      if (done !== -1 && done <= seen) return;
    }
    marked.current = { generation, id: newestVisible };
    markRead(client, jobId, newestVisible, generation).then(onUnread, () => undefined);
  }, [client, focused, foreground, generation, jobId, messages, newestVisible, onUnread, unread]);
}
