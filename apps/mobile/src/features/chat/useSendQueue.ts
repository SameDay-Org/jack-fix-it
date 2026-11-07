import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";

import { ApiError, SessionExpiredError } from "@/api";

import { sendMessage } from "./api";
import type { Pending } from "./thread";

const CHAT_CLOSED = "chat_closed";

/** Why the last send did not go through, when the screen says it beside the composer. */
export type SendNotice = "tooFast" | null;

export type SendOutcome = "sent" | "failed" | "tooFast" | "refused" | "closed" | "void";

/** How a failed send reads: worth another try, refused for good, or a closed chat. */
function outcomeOf(error: unknown): Exclude<SendOutcome, "sent"> {
  // The session the message was typed in is gone: nothing about it is drawn.
  if (error instanceof SessionExpiredError) return "void";
  if (error instanceof ApiError) {
    if (error.status === 409 && error.code === CHAT_CLOSED) return "closed";
    // Too fast (429) or the server's own trouble: the same text can go later.
    if (error.status === 429) return "tooFast";
    if (error.status >= 500) return "failed";
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

/** Whose queue it is: one session generation on one job. */
const ownerOf = (jobId: string, generation: number): string => `${generation}:${jobId}`;

type Held = { owner: string; items: Pending[]; notice: SendNotice };

const NOTHING: Pending[] = [];

/**
 * The messages the screen sends, shown at once as their own bubbles (`Pending`) until the API
 * stores them: one at a time and in the order typed, so the thread keeps that order. A stored
 * message leaves the queue (the thread holds it); a failure stays as a bubble that can be tried
 * again (`failed`) or that cannot (`refused`: the API refused the text; or the chat closed, which
 * `onClosed` also hears). `onDone` hears each outcome, for the screen's announcement.
 *
 * The queue belongs to the session generation and the job it was typed in (#74 round 1): when
 * either changes (a sign-out, an expired session, another account), every bubble is dropped with
 * its text, at once, and its retry with it. A send still on its way stays pinned to the generation
 * it was typed in (the API refuses it for any other), and whatever it answers draws and says
 * nothing for the next owner.
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
  const owner = ownerOf(jobId, generation);
  const [held, setHeld] = useState<Held>({ owner, items: [], notice: null });
  // Another owner: drop the last one's bubbles now, during this render, not after it.
  if (held.owner !== owner) setHeld({ owner, items: [], notice: null });
  const mine = held.owner === owner;
  const pending = mine ? held.items : NOTHING;
  const notice = mine ? held.notice : null;

  const current = useRef(owner);
  const chain = useRef({ owner, tail: Promise.resolve() });
  const nextId = useRef(0);
  const listeners = useRef({ onClosed, onDone });
  useEffect(() => {
    listeners.current = { onClosed, onDone };
  }, [onClosed, onDone]);
  useEffect(() => {
    current.current = owner;
  }, [owner]);

  /** Changes the queue only while it still belongs to `itemOwner`. */
  const change = useCallback((itemOwner: string, next: (state: Held) => Partial<Held>) => {
    setHeld((state) => (state.owner === itemOwner ? { ...state, ...next(state) } : state));
  }, []);

  const update = useCallback(
    (itemOwner: string, localId: string, state: Pending["state"]) => {
      change(itemOwner, ({ items }) => ({
        items: items.map((item) => (item.localId === localId ? { ...item, state } : item)),
      }));
    },
    [change],
  );

  const attempt = useCallback(
    (item: Pending) => {
      const itemOwner = owner;
      // A handler from before the owner changed (a tap landing during the switch) does nothing.
      if (current.current !== itemOwner) return;
      // A new owner starts its own line: it never waits behind the last owner's sends.
      if (chain.current.owner !== itemOwner) {
        chain.current = { owner: itemOwner, tail: Promise.resolve() };
      }
      chain.current.tail = chain.current.tail.then(async () => {
        if (current.current !== itemOwner) return;
        try {
          await sendMessage(client, jobId, item.body, generation);
          if (current.current !== itemOwner) return;
          change(itemOwner, ({ items }) => ({
            items: items.filter(({ localId }) => localId !== item.localId),
            notice: null,
          }));
          listeners.current.onDone("sent");
        } catch (error) {
          const outcome = outcomeOf(error);
          if (outcome === "void" || current.current !== itemOwner) return;
          const retryable = outcome === "failed" || outcome === "tooFast";
          update(itemOwner, item.localId, retryable ? "failed" : "refused");
          change(itemOwner, () => ({ notice: outcome === "tooFast" ? "tooFast" : null }));
          if (outcome === "closed") listeners.current.onClosed();
          listeners.current.onDone(outcome);
        }
      });
    },
    [change, client, generation, jobId, owner, update],
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
      change(owner, ({ items }) => ({ items: [...items, item] }));
      attempt(item);
    },
    [attempt, change, generation, owner],
  );

  const retry = useCallback(
    (localId: string) => {
      // Only this owner's bubbles: a dropped one is gone, and its retry with it.
      const item = pending.find((candidate) => candidate.localId === localId);
      if (!item || item.state !== "failed") return;
      update(owner, localId, "sending");
      attempt(item);
    },
    [attempt, owner, pending, update],
  );

  return { pending, notice, send, retry };
}
