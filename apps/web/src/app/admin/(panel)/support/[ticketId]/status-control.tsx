"use client";

import { useActionState } from "react";

import { Button } from "@/components/ui/button";

import { setTicketStatus, type StatusError, type StatusState } from "../actions";
import { TICKET_STATUSES, type TicketStatus } from "../tickets";

export type StatusControlText = {
  label: string;
  saving: string;
  saved: string;
  statuses: Record<TicketStatus, string>;
  errors: Record<StatusError, string>;
};

const initialState: StatusState = { error: null, saved: false };

/**
 * The ticket's status as three buttons: the current one is pressed, the others move the
 * ticket there through the server action. The staff session never reaches this component.
 *
 * No button is ever `disabled`: the one just clicked keeps the keyboard focus while the change
 * is saved and when it becomes the pressed one. The pressed button submits nothing, a click
 * while a change is being saved is ignored, and the outcome is announced (saving, saved, or
 * the error).
 */
export function StatusControl({
  ticketId,
  status,
  text,
}: {
  ticketId: string;
  status: TicketStatus;
  text: StatusControlText;
}) {
  const [state, action, pending] = useActionState(
    setTicketStatus.bind(null, ticketId),
    initialState,
  );
  const error = state.error ? text.errors[state.error] : null;

  return (
    <form action={action} className="flex flex-col gap-3">
      <div className="flex min-h-9 flex-wrap items-center gap-x-4 gap-y-2">
        <div role="group" aria-label={text.label} className="flex flex-wrap gap-2">
          {TICKET_STATUSES.map((value) => {
            const current = value === status;
            const waiting = pending && !current;
            return (
              <Button
                key={value}
                type={current ? "button" : "submit"}
                name="status"
                value={value}
                size="sm"
                variant={current ? "primary" : "secondary"}
                aria-pressed={current}
                aria-disabled={waiting ? true : undefined}
                onClick={pending ? (event) => event.preventDefault() : undefined}
                className={
                  current
                    ? "cursor-default hover:bg-green-500 hover:text-navy-900"
                    : waiting
                      ? "cursor-default opacity-60"
                      : undefined
                }
              >
                {text.statuses[value]}
              </Button>
            );
          })}
        </div>
        <p role="status" className="text-sm text-gray-500">
          {pending ? text.saving : state.saved ? text.saved : ""}
        </p>
      </div>
      {error ? (
        <p role="alert" className="text-sm font-semibold text-danger">
          {error}
        </p>
      ) : null}
    </form>
  );
}
