"use client";

import { useActionState } from "react";

import { Button } from "@/components/ui/button";

import { setTicketStatus, type StatusError, type StatusState } from "../actions";
import { TICKET_STATUSES, type TicketStatus } from "../tickets";

export type StatusControlText = {
  label: string;
  saving: string;
  statuses: Record<TicketStatus, string>;
  errors: Record<StatusError, string>;
};

const initialState: StatusState = { error: null };

/**
 * The ticket's status as three buttons: the current one is pressed, the others move the
 * ticket there through the server action. The staff session never reaches this component.
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
      <div role="group" aria-label={text.label} className="flex flex-wrap gap-2">
        {TICKET_STATUSES.map((value) => {
          const current = value === status;
          return (
            <Button
              key={value}
              type="submit"
              name="status"
              value={value}
              size="sm"
              variant={current ? "primary" : "secondary"}
              aria-pressed={current}
              disabled={current || pending}
              // The pressed one is not a dimmed choice: it is the answer.
              className={current ? "disabled:opacity-100" : undefined}
            >
              {text.statuses[value]}
            </Button>
          );
        })}
      </div>
      <p role="status" className="min-h-5 text-sm text-gray-500">
        {pending ? text.saving : ""}
      </p>
      {error ? (
        <p role="alert" className="text-sm font-semibold text-danger">
          {error}
        </p>
      ) : null}
    </form>
  );
}
