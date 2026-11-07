import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";

import { ApiError, SessionExpiredError } from "@/api";

import { sendMessage } from "./api";
import type { Pending } from "./thread";

const CHAT_CLOSED = "chat_closed";

/** Why the last send did not go through, when the screen says it beside the composer. */
export type SendNotice = "tooFast" | null;

export type SendOutcome = "sent" | "failed" | "refused" | "closed" | "void";

/** How a failed send reads: worth another try, refused for good, or a closed chat. */
function outcomeOf(error: unknown): Exclude<SendOutcome, "sent"> {
  // The session the message was typed in is gone: nothing about it is drawn.
  if (error instanceof SessionExpiredError) return "void";
  if (error instanceof ApiError) {
    if (error.status === 409 && error.code === CHAT_CLOSED) return "closed";
    // Too fast (429) or the server's own trouble: the same text can go later.
    if (error.status === 429 || error.status >= 500) return "failed";
    return "refused";
  }
  return "failed"; // no answer: offline or timed out
}

export type SendQueue = {
  pending: Pending[];
  notice: SendNotice;
  send: (body: string) => void;
  retry: (localId: string) => void;
};

/**
 * The messages the screen sends, shown at once as their own bubbles (`Pending`) until the API
 * stores them: one at a time and in the order typed, so the thread keeps that order. A stored
 * message leaves the queue (the thread holds it); a failure stays as a bubble that can be tried
 * again (`failed`) or that cannot (`refused`: the API refused the text; or the chat closed, which
 * `onClosed` also hears). `onDone` hears each outcome, for the screen's announcement. Every send
 * is pinned to the session generation it was typed in; after a sign-out nothing is drawn.
 */
export function useSendQueue(
  jobId: string,
  generation: number,
  {
    onClosed,
    onDone,
  }: { onClosed: () => void; onDone: (outcome: Exclude<SendOutcome, "void">) => void },
): SendQueue {
  const client = useQueryClient();
  const [pending, setPending] = useState<Pending[]>([]);
  const [notice, setNotice] = useState<SendNotice>(null);
  const chain = useRef<Promise<void>>(Promise.resolve());
  const nextId = useRef(0);
  const listeners = useRef({ onClosed, onDone });
  useEffect(() => {
    listeners.current = { onClosed, onDone };
  }, [onClosed, onDone]);

  const update = useCallback((localId: string, state: Pending["state"]) => {
    setPending((items) =>
      items.map((item) => (item.localId === localId ? { ...item, state } : item)),
    );
  }, []);

  const attempt = useCallback(
    (item: Pending) => {
      chain.current = chain.current.then(async () => {
        try {
          await sendMessage(client, jobId, item.body, generation);
          setPending((items) => items.filter(({ localId }) => localId !== item.localId));
          setNotice(null);
          listeners.current.onDone("sent");
        } catch (error) {
          const outcome = outcomeOf(error);
          if (outcome === "void") return;
          update(item.localId, outcome === "failed" ? "failed" : "refused");
          setNotice(error instanceof ApiError && error.status === 429 ? "tooFast" : null);
          if (outcome === "closed") listeners.current.onClosed();
          listeners.current.onDone(outcome);
        }
      });
    },
    [client, generation, jobId, update],
  );

  const send = useCallback(
    (body: string) => {
      nextId.current += 1;
      const item: Pending = {
        localId: `${generation}-${nextId.current}`,
        body,
        at: Date.now(),
        state: "sending",
      };
      setPending((items) => [...items, item]);
      attempt(item);
    },
    [attempt, generation],
  );

  const retry = useCallback(
    (localId: string) => {
      const item = pending.find((candidate) => candidate.localId === localId);
      if (!item || item.state !== "failed") return;
      update(localId, "sending");
      attempt(item);
    },
    [attempt, pending, update],
  );

  return { pending, notice, send, retry };
}
