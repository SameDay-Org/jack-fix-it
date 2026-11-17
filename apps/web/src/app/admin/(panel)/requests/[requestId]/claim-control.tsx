"use client";

import { useActionState, useEffect, useRef } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import type { ClaimError, ClaimState } from "../actions";

export type ClaimControlText = {
  claim: string;
  release: string;
  saving: string;
  saved: string;
  errors: Record<ClaimError, string>;
};

const initialState: ClaimState = { error: null, saved: false };

/**
 * One button: take the request when nobody holds it, let go of it when the reader may (their
 * own, or anyone's for an admin). The page binds the server action to the request's id; the
 * staff session never reaches this component.
 *
 * The button is never `disabled`, so the keyboard focus never lands on a dead control: a
 * click while the change is being saved is ignored, and the outcome is announced (saving,
 * saved, or the error).
 *
 * `kind` is null when the reader can do neither (someone else holds the request): the page
 * still renders this control there, so a take that lost the race to another agent keeps its
 * announcement after the card refreshes, and the focus moves from the button that is gone to
 * that announcement instead of the page's body.
 */
export function ClaimControl({
  action,
  kind,
  text,
}: {
  action: (previous: ClaimState) => Promise<ClaimState>;
  kind: "claim" | "release" | null;
  text: ClaimControlText;
}) {
  const [state, submit, pending] = useActionState(action, initialState);
  const error = state.error ? text.errors[state.error] : null;
  const alert = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    if (kind === null && error) alert.current?.focus();
  }, [kind, error]);

  return (
    <form action={submit} className="flex flex-col">
      <div
        className={cn("flex flex-wrap items-center gap-x-4 gap-y-2", kind !== null && "min-h-9")}
      >
        {kind === null ? null : (
          <Button
            type="submit"
            size="sm"
            variant={kind === "claim" ? "primary" : "secondary"}
            aria-disabled={pending ? true : undefined}
            onClick={pending ? (event) => event.preventDefault() : undefined}
            className={pending ? "cursor-default opacity-60" : undefined}
          >
            {kind === "claim" ? text.claim : text.release}
          </Button>
        )}
        <p role="status" className="text-sm text-gray-500">
          {pending ? text.saving : state.saved ? text.saved : ""}
        </p>
      </div>
      {error ? (
        <p
          ref={alert}
          role="alert"
          tabIndex={-1}
          className="mt-3 text-sm font-semibold text-danger outline-none"
        >
          {error}
        </p>
      ) : null}
    </form>
  );
}
