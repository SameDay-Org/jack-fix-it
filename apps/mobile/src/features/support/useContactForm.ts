import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";

import { isCurrentGeneration, sessionGeneration, useSessionGeneration } from "@/api";
import { useActiveJob } from "@/features/jobs";
import { useProJobs } from "@/features/pro-jobs";

import { sendFailureOf, sendTicket, type SendFailure, type Ticket } from "./api";
import {
  beginSend,
  charactersOver,
  dismissOutcome,
  endSend,
  resetDraft,
  ticketOf,
  updateDraft,
  useDraft,
  useSending,
  type Draft,
} from "./draft";

export type JobChoice = { id: string; label: string };

/**
 * The jobs a message can be about: the customer's job under way, or the pro's current jobs, by
 * the name of the other person. Empty for someone with none, and the form then asks nothing.
 */
export function useJobChoices(): JobChoice[] {
  const { t } = useTranslation();
  const { active } = useActiveJob();
  const { data: proJobs } = useProJobs({ refetchOnReturn: false });

  if (active) {
    const { id, pro } = active.job;
    return [
      { id, label: pro.name ? t("support.job.withPro", { name: pro.name }) : t("support.job.own") },
    ];
  }
  return (proJobs ?? []).map(({ id, customer_first_name: name }) => ({
    id,
    label: name ? t("support.job.forCustomer", { name }) : t("support.job.own"),
  }));
}

export type ContactForm = {
  draft: Draft;
  /** The chosen job, while it is still one of `jobs`. */
  jobId: string | null;
  /** The message as it would go, or null while it cannot (no topic, no text, too long). */
  ticket: Ticket | null;
  /** How many characters the text is past the limit. */
  over: number;
  /** A message is on its way: the server has not answered yet. */
  busy: boolean;
  /** The last message went: the form gives way to the confirmation. */
  sent: boolean;
  /** Why the last try did not go; the draft is still there. */
  failure: SendFailure | null;
  submit: () => void;
  writeAnother: () => void;
};

/**
 * The form's state and its one action (#274, part 2).
 *
 * - One message is on its way at a time. The lock is in the store beside the draft (`draft.ts`)
 *   and closes before anything else happens: a second tap in the same frame sends nothing, and
 *   neither does a form that was left mid-send and opened again, which comes back still waiting.
 * - A message that went clears the draft; one that did not stays, with the reason. A job the
 *   server refuses is taken off the draft. Nothing is sent again by itself.
 * - The send settles whether or not the form is still open. What became of it shows on the visit
 *   it settles in, or on the next one; once seen, it is not shown again.
 * - Everything is bound to the session the message was written in: an answer that lands after a
 *   sign-out touches neither the next person's draft nor their screen.
 */
export function useContactForm(jobs: readonly JobChoice[]): ContactForm {
  const client = useQueryClient();
  const draft = useDraft();
  const { sendingIn, sent, failure } = useSending();
  const busy = sendingIn === useSessionGeneration();

  // Leaving the form ends the visit: its confirmation or failure notice does not greet the next.
  useEffect(() => dismissOutcome, []);

  // A job that ended since it was chosen is no longer offered, so it is not sent either.
  const jobId = jobs.some((job) => job.id === draft.jobId) ? draft.jobId : null;
  const ticket = ticketOf({ ...draft, jobId });

  const submit = () => {
    if (!ticket) return;
    const generation = sessionGeneration();
    if (!beginSend(generation)) return;
    sendTicket(client, ticket, generation).then(
      () => {
        if (!isCurrentGeneration(generation)) return;
        resetDraft();
        endSend(generation, { sent: true });
      },
      (error: unknown) => {
        if (!isCurrentGeneration(generation)) return;
        const reason = sendFailureOf(error);
        if (reason === "invalidJob") updateDraft({ jobId: null });
        endSend(generation, { failure: reason });
      },
    );
  };

  return {
    draft,
    jobId,
    ticket,
    over: charactersOver(draft.message),
    busy,
    sent,
    failure,
    submit,
    writeAnother: dismissOutcome,
  };
}
