"use server";

import { revalidatePath } from "next/cache";

import { ApiError, apiPost } from "@/lib/api";
import { staffActionAuth } from "@/lib/session";

import { isUuid } from "../support/tickets";
import { type Decision, isDecision, proHref, PROS_PATH, REASON_MAX_LENGTH } from "./pros";

/** The outcomes a review control shows, each with its own i18n message. */
export type ReviewError =
  | "reason_required"
  | "not_found"
  | "already_reviewed"
  | "not_approvable"
  | "forbidden"
  | "unavailable";
/** `saved` once a decision went through, so the control can say so. */
export type ReviewState = { error: ReviewError | null; saved: boolean };

type Review = { decision: Decision; reason?: string };

function errorOf(failure: unknown): ReviewError {
  if (!(failure instanceof ApiError)) return "unavailable"; // network or configuration
  if (failure.status === 404) return "not_found";
  if (failure.status === 403) return "forbidden";
  if (failure.status === 409) return "already_reviewed";
  if (failure.status === 422 && failure.code === "pro_not_approvable") return "not_approvable";
  return "unavailable";
}

/**
 * The decision a form carries, as the API takes it: a rejection with its reason (trimmed, one
 * to REASON_MAX_LENGTH characters), an approval with none. An error when the form holds
 * anything else.
 */
function reviewOf(form: FormData): Review | ReviewError {
  const decision = form.get("decision");
  if (!isDecision(decision)) return "unavailable";
  if (decision === "approved") return { decision };
  const typed = form.get("reason");
  const reason = typeof typed === "string" ? typed.trim() : "";
  if (reason === "" || reason.length > REASON_MAX_LENGTH) return "reason_required";
  return { decision, reason };
}

function refresh(proId: string): void {
  // The page shows the pro as the API has them now, and the list moves them to their tab.
  revalidatePath(proHref(proId));
  revalidatePath(PROS_PATH);
}

/** The refusals that mean the page is out of date: it is read again, so it shows why. */
const STALE: readonly ReviewError[] = ["not_approvable", "already_reviewed", "not_found"];

/**
 * What a failed call answers. When the API refused because the pro or the document changed
 * since the page was loaded (a document reviewed or replaced meanwhile, an approval that now
 * misses something), the page is refreshed too: the message points at what the page lists.
 */
function refusal(proId: string, failure: unknown): ReviewState {
  const error = errorOf(failure);
  if (STALE.includes(error)) refresh(proId);
  return { error, saved: false };
}

/**
 * Approves or rejects one of a pro's documents. A server action is a public endpoint, so it
 * checks the staff session itself (`staffActionAuth`: an expired access token is renewed in
 * place, and without a staff session the person goes to the login) and sends only ids that are
 * UUIDs, a decision the API knows and, for a rejection, a reason. The API checks the role
 * again and records the review in the audit log. Next.js checks that the action's Origin
 * matches the host, so another site cannot post this form.
 */
export async function reviewDocument(
  proId: string,
  documentId: string,
  _previous: ReviewState,
  form: FormData,
): Promise<ReviewState> {
  if (!isUuid(proId) || !isUuid(documentId)) return { error: "unavailable", saved: false };
  const review = reviewOf(form);
  if (typeof review === "string") return { error: review, saved: false };
  const auth = await staffActionAuth();
  try {
    await apiPost("/v1/admin/pros/{pro_id}/documents/{document_id}/review", review, {
      ...auth,
      params: { pro_id: proId, document_id: documentId },
    });
  } catch (failure) {
    return refusal(proId, failure);
  }
  refresh(proId);
  return { error: null, saved: true };
}

/**
 * Approves or rejects the pro's profile, with the same checks as `reviewDocument`. The API
 * refuses an approval while a document, a category or a service area is missing
 * (`not_approvable`): the page lists what is.
 */
export async function decidePro(
  proId: string,
  _previous: ReviewState,
  form: FormData,
): Promise<ReviewState> {
  if (!isUuid(proId)) return { error: "unavailable", saved: false };
  const review = reviewOf(form);
  if (typeof review === "string") return { error: review, saved: false };
  const auth = await staffActionAuth();
  try {
    await apiPost("/v1/admin/pros/{pro_id}/decision", review, {
      ...auth,
      params: { pro_id: proId },
    });
  } catch (failure) {
    return refusal(proId, failure);
  }
  refresh(proId);
  return { error: null, saved: true };
}
