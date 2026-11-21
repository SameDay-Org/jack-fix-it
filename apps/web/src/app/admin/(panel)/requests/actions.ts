"use server";

import { revalidatePath } from "next/cache";

import { ApiError, apiPost } from "@/lib/api";
import { staffActionAuth } from "@/lib/session";

import { FOLLOWUPS_PATH } from "../followups/followups";
import { businessTimeZone } from "../kpis/config";
import { isUuid, QUEUE_PATH, requestHref } from "../queue/queue";
import {
  dueError,
  FOLLOWUP_NOTE_MAX_LENGTH,
  NOTE_MAX_LENGTH,
  type OpsError,
  type OpsState,
  zonedInstant,
} from "./ops";
import { followupMaxDays, opsErrorOf } from "./ops-server";

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

// --- The BDC's actions on a request (#82) -------------------------------------------------

function refreshOps(requestId: string): void {
  // The card shows the action's result, the follow-ups page and the queue what changed.
  revalidatePath(requestHref(requestId));
  revalidatePath(FOLLOWUPS_PATH);
  revalidatePath(QUEUE_PATH);
}

/** The refusals that leave the card as it was: nothing to read again. */
const UNCHANGED: readonly OpsError[] = [
  "validation_error",
  "category_inactive",
  "followup_due_out_of_range",
  "assignee_not_staff",
  "rate_limited",
];

/**
 * Sends one action and maps its outcome. A server action is a public endpoint, so each one
 * checks the staff session itself (`staffActionAuth`) and sends only UUIDs and checked fields;
 * the API checks the role, the holder rule and the request's state again, and records the
 * action in the audit log. Next.js checks the action's Origin. One call, never retried here: a
 * call that did not answer may have gone through, so it ends `unconfirmed` and the card is read
 * again; the staff member decides what next.
 */
async function act(requestId: string, call: (auth: RequestInit) => Promise<unknown>) {
  const auth = await staffActionAuth();
  try {
    await call(auth);
  } catch (failure) {
    const error = opsErrorOf(failure);
    if (!UNCHANGED.includes(error)) refreshOps(requestId);
    return { error, saved: false } satisfies OpsState;
  }
  refreshOps(requestId);
  return { error: null, saved: true } satisfies OpsState;
}

function text(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value.trim() : "";
}

/** Adds an internal note to a request: plain text, 1 to NOTE_MAX_LENGTH characters. */
export async function addNote(
  requestId: string,
  _previous: OpsState,
  form: FormData,
): Promise<OpsState> {
  if (!isUuid(requestId)) return { error: "request_not_found", saved: false };
  const body = text(form, "body");
  if (body === "") return { error: "note_empty", saved: false };
  if (body.length > NOTE_MAX_LENGTH) return { error: "note_too_long", saved: false };
  return act(requestId, (auth) =>
    apiPost(
      "/v1/admin/requests/{request_id}/notes",
      { body },
      {
        ...auth,
        params: { request_id: requestId },
      },
    ),
  );
}

/** Records the first contact with the customer (set once by the API: a second press keeps it). */
export async function markContacted(requestId: string): Promise<OpsState> {
  if (!isUuid(requestId)) return { error: "request_not_found", saved: false };
  return act(requestId, (auth) =>
    apiPost("/v1/admin/requests/{request_id}/contacted", undefined, {
      ...auth,
      params: { request_id: requestId },
    }),
  );
}

/** Sets a request's category, while the API still allows it (received or reviewing). */
export async function classifyRequest(
  requestId: string,
  _previous: OpsState,
  form: FormData,
): Promise<OpsState> {
  const categoryId = text(form, "category_id");
  if (!isUuid(requestId)) return { error: "request_not_found", saved: false };
  if (!isUuid(categoryId)) return { error: "validation_error", saved: false };
  return act(requestId, (auth) =>
    apiPost(
      "/v1/admin/requests/{request_id}/classify",
      { category_id: categoryId },
      { ...auth, params: { request_id: requestId } },
    ),
  );
}

/**
 * Schedules a follow-up: its due day and time are typed in the business time zone and sent as
 * an instant with that zone's offset on that day; due ahead, at most OPS_FOLLOWUP_MAX_DAYS
 * away; a note of 1 to FOLLOWUP_NOTE_MAX_LENGTH characters; another assignee only from an
 * admin's form (the API checks the role and that the assignee is active staff).
 */
export async function scheduleFollowup(
  requestId: string,
  _previous: OpsState,
  form: FormData,
): Promise<OpsState> {
  if (!isUuid(requestId)) return { error: "request_not_found", saved: false };
  const due = zonedInstant(text(form, "day"), text(form, "time"), businessTimeZone());
  const dueProblem = dueError(due, Date.now(), followupMaxDays());
  if (dueProblem) return { error: dueProblem, saved: false };
  const note = text(form, "note");
  if (note === "") return { error: "note_empty", saved: false };
  if (note.length > FOLLOWUP_NOTE_MAX_LENGTH) return { error: "note_too_long", saved: false };
  const assignee = text(form, "assigned_to");
  if (assignee !== "" && !isUuid(assignee)) return { error: "validation_error", saved: false };
  return act(requestId, (auth) =>
    apiPost(
      "/v1/admin/requests/{request_id}/followups",
      {
        due_at: (due as Date).toISOString(),
        note,
        ...(assignee ? { assigned_to: assignee } : {}),
      },
      { ...auth, params: { request_id: requestId } },
    ),
  );
}

/** Marks a follow-up done (its assignee or an admin; the API checks, and a repeat is kept). */
export async function completeFollowup(requestId: string, followupId: string): Promise<OpsState> {
  if (!isUuid(requestId) || !isUuid(followupId)) {
    return { error: "request_not_found", saved: false };
  }
  return act(requestId, (auth) =>
    apiPost("/v1/admin/requests/{request_id}/followups/{followup_id}/done", undefined, {
      ...auth,
      params: { request_id: requestId, followup_id: followupId },
    }),
  );
}
