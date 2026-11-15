import { useQueryClient } from "@tanstack/react-query";
import * as Haptics from "expo-haptics";
import { useEffect } from "react";

import { isCurrentGeneration, sessionGeneration, useSessionGeneration } from "@/api";

import { reviewBodyOf, reviewFailureOf, sendReview, type ReviewBody, type ReviewSide } from "./api";
import { beginSend, dismissOutcome, endSend, useReviewForm, type ReviewForm } from "./draft";

export type RateForm = ReviewForm & {
  /** The review as it would go, or null while it cannot (no overall, a comment too long). */
  body: ReviewBody | null;
  /** The review is on its way: the server has not answered yet. */
  busy: boolean;
  submit: () => void;
};

/**
 * The rating screen's state and its one action (#77).
 *
 * - One review is on its way at a time per job. The lock is in the store beside the draft
 *   (`draft.ts`) and closes before anything else happens: a second tap in the same frame sends
 *   nothing, and neither does a screen left mid-send and opened again.
 * - A review that went clears the draft and leaves its thanks; one that did not stays, with the
 *   reason. Nothing is sent again by itself (a 429 included).
 * - Everything is bound to the session the review was written in: an answer that lands after a
 *   sign-out touches neither the next person's drafts nor their screen.
 */
export function useRateForm(jobId: string, side: ReviewSide): RateForm {
  const client = useQueryClient();
  const form = useReviewForm(jobId);
  const busy = form.sendingIn === useSessionGeneration();

  // Leaving the screen ends the visit: its thanks or failure notice does not greet the next.
  useEffect(() => () => dismissOutcome(jobId), [jobId]);

  const body = reviewBodyOf(side, form.ratings, form.comment);

  const submit = () => {
    if (!body) return;
    const generation = sessionGeneration();
    if (!beginSend(jobId, generation)) return;
    sendReview(client, jobId, body, generation).then(
      (redacted) => {
        if (!isCurrentGeneration(generation)) return;
        endSend(jobId, generation, { sent: { overall: body.overall, redacted } });
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(
          () => undefined,
        );
      },
      (error: unknown) => {
        if (!isCurrentGeneration(generation)) return;
        endSend(jobId, generation, { failure: reviewFailureOf(error) });
      },
    );
  };

  return { ...form, body, busy, submit };
}
