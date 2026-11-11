"use server";

import { revalidatePath } from "next/cache";

import { ApiError, apiPatch } from "@/lib/api";
import { staffAuth } from "@/lib/session";

import { isTicketStatus, isUuid, SUPPORT_PATH, ticketHref } from "./tickets";

/** The outcomes the status control shows, each with its own i18n message. */
export type StatusError = "not_found" | "forbidden" | "unavailable";
export type StatusState = { error: StatusError | null };

function errorOf(failure: unknown): StatusError {
  if (!(failure instanceof ApiError)) return "unavailable"; // network or configuration
  if (failure.status === 404) return "not_found";
  if (failure.status === 403) return "forbidden";
  return "unavailable";
}

/**
 * Moves a ticket to another status. A server action is a public endpoint, so it checks the
 * staff session itself (`staffAuth`, which redirects when there is none) and sends only a
 * ticket id that is a UUID and a status the API knows. The API checks the role again and
 * records the change in the audit log. Next.js checks that the action's Origin matches the
 * host, so another site cannot post this form.
 */
export async function setTicketStatus(
  ticketId: string,
  _previous: StatusState,
  form: FormData,
): Promise<StatusState> {
  const status = form.get("status");
  if (!isUuid(ticketId) || !isTicketStatus(status)) return { error: "unavailable" };
  const auth = await staffAuth();
  try {
    await apiPatch(
      "/v1/admin/support/tickets/{ticket_id}",
      { status },
      { ...auth, params: { ticket_id: ticketId } },
    );
  } catch (failure) {
    return { error: errorOf(failure) };
  }
  // The page shows the ticket as the API has it now, and the list moves it to its new status.
  revalidatePath(ticketHref(ticketId));
  revalidatePath(SUPPORT_PATH);
  return { error: null };
}
