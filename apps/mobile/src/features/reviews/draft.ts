import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";

import { onSignOut } from "@/api";
import type { StarScore } from "@/components/ui";

import type { Aspect, ReviewFailure } from "./api";

/**
 * One job's review being written, and where its send stands. Both live here, outside the screen,
 * because the draft outlives it: leaving the rating screen and coming back keeps the stars and the
 * comment, and a screen opened again while its review is on its way is still waiting, so the same
 * review cannot go twice. In memory only, never on disk, and forgotten with the session.
 */
export type ReviewForm = {
  ratings: Partial<Record<Aspect, StarScore>>;
  comment: string;
  /** The session (its generation) the review is on its way in; null while none is. */
  sendingIn: number | null;
  /** The review went: its stars, and whether contact details were masked in its comment. */
  sent: { overall: number; redacted: boolean } | null;
  /** Why the last try did not go; the draft is still there (unless the job was rated already). */
  failure: ReviewFailure | null;
  /**
   * The server refused a review because this person already rated the job (409 `already_reviewed`).
   * Final for the job and the session, whatever the next read of "mine" answers: nothing more is
   * sent, and the screen shows the saved stars once it can read them.
   */
  alreadyReviewed: boolean;
};

const EMPTY: ReviewForm = {
  ratings: {},
  comment: "",
  sendingIn: null,
  sent: null,
  failure: null,
  alreadyReviewed: false,
};

/** By job id: two jobs' reviews never share a draft or a lock. */
const formsStore = createStore<Record<string, ReviewForm>>()(() => ({}));

const formOf = (jobId: string): ReviewForm => formsStore.getState()[jobId] ?? EMPTY;

function change(jobId: string, next: Partial<ReviewForm>): void {
  formsStore.setState((forms) => ({ ...forms, [jobId]: { ...formOf(jobId), ...next } }));
}

export const useReviewForm = (jobId: string): ReviewForm =>
  useStore(formsStore, (forms) => forms[jobId] ?? EMPTY);

export function rate(jobId: string, aspect: Aspect, score: StarScore | null): void {
  const { [aspect]: _dropped, ...rest } = formOf(jobId).ratings;
  change(jobId, { ratings: score === null ? rest : { ...rest, [aspect]: score } });
}

export function writeComment(jobId: string, comment: string): void {
  change(jobId, { comment });
}

/**
 * Closes the job's lock for one send, at once. False while its review is already on its way in
 * this session, or once the server said the job was rated: nothing more may go. A lock left by
 * another session holds nobody back.
 */
export function beginSend(jobId: string, generation: number): boolean {
  const form = formOf(jobId);
  if (form.sendingIn === generation || form.alreadyReviewed) return false;
  change(jobId, { sendingIn: generation, sent: null, failure: null });
  return true;
}

/**
 * Opens the lock and keeps how the send ended: a review that went takes its draft with it, one
 * that did not keeps it. A job rated already drops the refused draft too (its stars are never
 * shown as the saved ones) and stays rated. Does nothing for a send of another session.
 */
export function endSend(
  jobId: string,
  generation: number,
  outcome: { sent: { overall: number; redacted: boolean } } | { failure: ReviewFailure | null },
): void {
  if (formOf(jobId).sendingIn !== generation) return;
  if ("sent" in outcome) change(jobId, { ...EMPTY, sent: outcome.sent });
  else if (outcome.failure === "alreadyReviewed")
    change(jobId, { ...EMPTY, failure: outcome.failure, alreadyReviewed: true });
  else change(jobId, { sendingIn: null, failure: outcome.failure });
}

/**
 * The thanks or the failure notice has been seen: the next visit starts without it (a review that
 * went shows its thanks from the job's "mine" from then on).
 */
export function dismissOutcome(jobId: string): void {
  const { sent, failure } = formOf(jobId);
  if (sent !== null || failure !== null) change(jobId, { sent: null, failure: null });
}

/** Forgets every draft and send: the next person on this phone finds nothing of them. */
export function forgetReviews(): void {
  formsStore.setState({}, true);
}

onSignOut(forgetReviews);
