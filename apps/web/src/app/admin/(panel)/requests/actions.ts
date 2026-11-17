"use server";

import { revalidatePath } from "next/cache";

import { ApiError, apiPost } from "@/lib/api";
import { staffActionAuth } from "@/lib/session";

import { isUuid, QUEUE_PATH, requestHref } from "../queue/queue";

/** The outcomes the claim control shows, each with its own i18n message. */
export type ClaimError = "held" | "not_found" | "forbidden" | "unavailable";
/** `saved` once the change went through, so the control can say so. */
export type ClaimState = { error: ClaimError | null; saved: boolean };

function errorOf(failure: unknown): ClaimError {
  if (!(failure instanceof ApiError)) return "unavailable"; // network or configuration
  if (failure.status === 409) return "held";
  if (failure.status === 404) return "not_found";
  if (failure.status === 403) return "forbidden";
  return "unavailable";
}

function refresh(requestId: string): void {
  // The card shows who holds the request now, and the queue moves it to its tab.
  revalidatePath(requestHref(requestId));
  revalidatePath(QUEUE_PATH);
}

async function change(requestId: string, action: "claim" | "release"): Promise<ClaimState> {
  if (!isUuid(requestId)) return { error: "unavailable", saved: false };
  const auth = await staffActionAuth();
  try {
    await apiPost(
      action === "claim"
        ? "/v1/admin/requests/{request_id}/claim"
        : "/v1/admin/requests/{request_id}/release",
      undefined,
      { ...auth, params: { request_id: requestId } },
    );
  } catch (failure) {
    const error = errorOf(failure);
    // Someone else took or released it meanwhile: the card is read again, so it shows who.
    if (error === "held" || error === "not_found") refresh(requestId);
    return { error, saved: false };
  }
  refresh(requestId);
  return { error: null, saved: true };
}

/**
 * Takes a request for the signed-in staff member. A server action is a public endpoint, so it
 * checks the staff session itself (`staffActionAuth`: an expired access token is renewed in
 * place, and without a staff session the person goes to the login) and sends only a request
 * id that is a UUID. The API checks the role again, refuses a request someone else holds and
 * records the change in the audit log. Next.js checks that the action's Origin matches the
 * host, so another site cannot post this form.
 */
export async function claimRequest(requestId: string): Promise<ClaimState> {
  return change(requestId, "claim");
}

/** Lets go of a request, with the same checks as `claimRequest`. */
export async function releaseRequest(requestId: string): Promise<ClaimState> {
  return change(requestId, "release");
}
