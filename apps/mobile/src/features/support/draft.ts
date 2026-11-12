import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";

import { onSignOut } from "@/api";

import { MESSAGE_MAX, type SendFailure, type Ticket, type TicketTopic } from "./api";

/**
 * The message being written to the team: what leaving the form and coming back keeps. In memory
 * only, never on disk, and forgotten with the session (a sign-out, an expired session, another
 * account): the next person on this phone finds an empty form.
 */
export type Draft = { topic: TicketTopic | null; message: string; jobId: string | null };

const EMPTY: Draft = { topic: null, message: "", jobId: null };

const draftStore = createStore<Draft>()(() => EMPTY);

export const useDraft = (): Draft => useStore(draftStore);

export function updateDraft(change: Partial<Draft>): void {
  draftStore.setState(change);
}

export function resetDraft(): void {
  draftStore.setState(EMPTY, true);
}

/**
 * Where the last send stands. It lives beside the draft, not in the screen, because the draft
 * outlives the screen: a form left while its message is on its way and opened again is still
 * waiting, so the same text cannot be sent a second time; and what became of a message that
 * settled while the form was closed is there on the next visit.
 */
export type Sending = {
  /** The session (its generation) a message is on its way in; null while none is. */
  sendingIn: number | null;
  /** The last message went. */
  sent: boolean;
  /** Why the last try did not go. */
  failure: SendFailure | null;
};

const IDLE: Sending = { sendingIn: null, sent: false, failure: null };

const sendingStore = createStore<Sending>()(() => IDLE);

export const useSending = (): Sending => useStore(sendingStore);

/**
 * Closes the lock for one send, at once. False while a message is already on its way in this
 * session: nothing more may be sent. A lock left by another session holds nobody back.
 */
export function beginSend(generation: number): boolean {
  if (sendingStore.getState().sendingIn === generation) return false;
  sendingStore.setState({ sendingIn: generation, sent: false, failure: null });
  return true;
}

/** Opens the lock and keeps how the send ended. Does nothing for a send of another session. */
export function endSend(
  generation: number,
  outcome: { sent: true } | { failure: SendFailure | null },
): void {
  if (sendingStore.getState().sendingIn !== generation) return;
  sendingStore.setState({ ...IDLE, ...outcome });
}

/** The confirmation or the failure notice has been seen: the next visit starts without it. */
export function dismissOutcome(): void {
  sendingStore.setState({ sent: false, failure: null });
}

/** Forgets the draft and where its send stood: the next person finds an empty, idle form. */
export function forgetForm(): void {
  resetDraft();
  sendingStore.setState(IDLE, true);
}

onSignOut(forgetForm);

/** How far the text is past the limit, in characters; 0 while it fits. Nothing is ever cut. */
export const charactersOver = (message: string): number =>
  Math.max(0, message.length - MESSAGE_MAX);

/**
 * The draft as a message that can be sent, or null while it cannot: a topic, some text that is
 * not only spaces, within the limit. The text goes as typed.
 */
export function ticketOf({ topic, message, jobId }: Draft): Ticket | null {
  if (topic === null || message.trim() === "" || charactersOver(message) > 0) return null;
  return { topic, message, jobId };
}
