"use client";

import { useActionState, useId, useState } from "react";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/input";

import type { ReviewError, ReviewState } from "./actions";
import { type Decision, REASON_MAX_LENGTH } from "./pros";

export type DecisionControlText = {
  label: string;
  approve: string;
  reject: string;
  /** Asked before an approval is sent, when `confirmApproval` is set. */
  approveQuestion: string;
  confirmApprove: string;
  confirmReject: string;
  cancel: string;
  reasonLabel: string;
  reasonHint: string;
  saving: string;
  saved: string;
  errors: Record<ReviewError, string>;
};

const initialState: ReviewState = { error: null, saved: false };

/**
 * Approve and reject, for a document or for the pro's profile, through a server action the
 * page binds to its ids. The staff session never reaches this component.
 *
 * A rejection always takes a second step: the reason, which the pro reads. An approval takes
 * one too when `confirmApproval` is set (the profile's), and goes straight through otherwise
 * (a document's). No button is ever `disabled`, so the keyboard focus never lands on a dead
 * control: a click while a decision is being saved is ignored, and the outcome is announced
 * (saving, saved, or the error).
 */
export function DecisionControl({
  action,
  offered,
  confirmApproval = false,
  text,
}: {
  action: (previous: ReviewState, form: FormData) => Promise<ReviewState>;
  /** The decisions that can still be taken: the current one is left out by the page. */
  offered: readonly Decision[];
  confirmApproval?: boolean;
  text: DecisionControlText;
}) {
  const [state, submit, pending] = useActionState(action, initialState);
  const [chosen, setChosen] = useState<Decision | null>(null);
  // The button that opened a step the user cancelled: it takes the focus back.
  const [returnTo, setReturnTo] = useState<Decision | null>(null);
  const reasonId = useId();
  // A decision that went through is no longer offered: back to the first step.
  const step = chosen !== null && offered.includes(chosen) ? chosen : null;
  const error = state.error ? text.errors[state.error] : null;
  const ignoreWhilePending = pending
    ? (event: { preventDefault: () => void }) => event.preventDefault()
    : undefined;
  const waiting = pending ? "cursor-default opacity-60" : undefined;
  const choose = (decision: Decision) => {
    if (pending) return;
    setChosen(decision);
    setReturnTo(null);
  };
  const cancel = () => {
    if (pending) return;
    setReturnTo(step);
    setChosen(null);
  };

  return (
    <form action={submit} className="flex flex-col">
      {step === null ? (
        <div role="group" aria-label={text.label} className="flex flex-wrap gap-2">
          {offered.map((decision) => {
            const asks = decision === "rejected" || confirmApproval;
            return (
              <Button
                key={decision}
                type={asks ? "button" : "submit"}
                name={asks ? undefined : "decision"}
                value={asks ? undefined : decision}
                size="sm"
                variant={decision === "approved" ? "primary" : "secondary"}
                autoFocus={decision === returnTo}
                aria-disabled={pending ? true : undefined}
                onClick={asks ? () => choose(decision) : ignoreWhilePending}
                className={waiting}
              >
                {decision === "approved" ? text.approve : text.reject}
              </Button>
            );
          })}
        </div>
      ) : (
        <div className="flex flex-col gap-3 rounded-md bg-gray-50 p-4">
          <input type="hidden" name="decision" value={step} />
          {step === "rejected" ? (
            <div className="flex flex-col gap-1">
              <Label htmlFor={reasonId}>{text.reasonLabel}</Label>
              <textarea
                id={reasonId}
                name="reason"
                required
                rows={3}
                maxLength={REASON_MAX_LENGTH}
                autoFocus
                aria-describedby={`${reasonId}-hint`}
                className="w-full rounded-md border border-gray-500/30 bg-white px-4 py-3 text-base text-navy-900 outline-none focus-visible:border-green-700 focus-visible:ring-2 focus-visible:ring-green-700/30"
              />
              <p id={`${reasonId}-hint`} className="text-sm text-gray-500">
                {text.reasonHint}
              </p>
            </div>
          ) : (
            <p className="text-sm font-semibold">{text.approveQuestion}</p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              type="submit"
              size="sm"
              autoFocus={step === "approved"}
              aria-disabled={pending ? true : undefined}
              onClick={ignoreWhilePending}
              className={waiting}
            >
              {step === "approved" ? text.confirmApprove : text.confirmReject}
            </Button>
            <Button type="button" size="sm" variant="secondary" onClick={cancel}>
              {text.cancel}
            </Button>
          </div>
        </div>
      )}
      <p role="status" className="mt-3 text-sm text-gray-500 empty:mt-0">
        {pending ? text.saving : state.saved ? text.saved : ""}
      </p>
      {error ? (
        <p role="alert" className="mt-3 text-sm font-semibold text-danger">
          {error}
        </p>
      ) : null}
    </form>
  );
}
