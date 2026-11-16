"use client";

import { useActionState } from "react";

import { Button } from "@/components/ui/button";

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
 */
export function ClaimControl({
  action,
  kind,
  text,
}: {
  action: (previous: ClaimState) => Promise<ClaimState>;
  kind: "claim" | "release";
  text: ClaimControlText;
}) {
  const [state, submit, pending] = useActionState(action, initialState);
  const error = state.error ? text.errors[state.error] : null;

  return (
    <form action={submit} className="flex flex-col">
      <div className="flex min-h-9 flex-wrap items-center gap-x-4 gap-y-2">
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
        <p role="status" className="text-sm text-gray-500">
          {pending ? text.saving : state.saved ? text.saved : ""}
        </p>
      </div>
      {error ? (
        <p role="alert" className="mt-3 text-sm font-semibold text-danger">
          {error}
        </p>
      ) : null}
    </form>
  );
}
