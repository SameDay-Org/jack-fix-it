"use server";

import { revalidatePath } from "next/cache";

import { apiPost } from "@/lib/api";
import { staffActionAuth } from "@/lib/session";

import { isUuid } from "../support/tickets";
import { disputeHref, DISPUTES_PATH, type ResolveError } from "./disputes";
import { resolveBodyOf, resolveErrorOf } from "./resolve";

/** `resolved` once the API settled the dispute, so the control can say so. */
export type ResolveState = { error: ResolveError | null; resolved: boolean };

/** The refusals that leave the page as it was: nothing changed, nothing to read again. */
const UNCHANGED: readonly ResolveError[] = ["forbidden", "invalid_split", "validation_error"];

function refresh(disputeId: string): void {
  // The page shows the dispute as the API has it now, and the list moves it to its view.
  revalidatePath(disputeHref(disputeId));
  revalidatePath(DISPUTES_PATH);
}

/**
 * Resolves a dispute: release, partial or refund, with the admin's note. A server action is a
 * public endpoint, so it checks the staff session itself (`staffActionAuth`) and sends only a
 * UUID, a decision the API knows, a partial's amount in cents (typed in dollars) and the note.
 * The API checks that the caller is an admin, computes every other amount from the job's
 * frozen payment and records the decision in the audit log. Next.js checks that the action's
 * Origin matches the host, so another site cannot post this form.
 *
 * One call per confirmation, never retried here: a call that did not answer may have gone
 * through, so it ends `unconfirmed` and the page is read again; the admin decides what next.
 */
export async function resolveDispute(
  disputeId: string,
  _previous: ResolveState,
  form: FormData,
): Promise<ResolveState> {
  if (!isUuid(disputeId)) return { error: "not_found", resolved: false };
  const body = resolveBodyOf(form);
  if (typeof body === "string") return { error: body, resolved: false };
  const auth = await staffActionAuth();
  try {
    await apiPost("/v1/admin/disputes/{dispute_id}/resolve", body, {
      ...auth,
      params: { dispute_id: disputeId },
    });
  } catch (failure) {
    const error = resolveErrorOf(failure);
    if (!UNCHANGED.includes(error)) refresh(disputeId);
    return { error, resolved: false };
  }
  refresh(disputeId);
  return { error: null, resolved: true };
}
