import { ApiError, SessionExpiredError, type PostBody } from "@/api";
import type { Category } from "@/features/home/useCategories";

import { intakeAnswersFor } from "./questions";
import type { RequestDraft, StepRefusal } from "./requestDraft";

export type RequestCreate = PostBody<"/v1/requests">;

/**
 * How a send that did not go through ends. `step`: the server named something the customer can
 * change, so the flow goes back to that step. `retry`: nothing was wrong with the request (offline,
 * a timeout, a 5xx, too many requests); Review offers it again. `rejected`: the server refused it
 * for a reason the app cannot place on a step. `signedOut`: the session ended; its own screens take
 * over.
 */
export type SendFailure =
  | { kind: "step"; refusal: StepRefusal }
  | { kind: "retry"; reason: "failed" | "rateLimited" }
  | { kind: "rejected" }
  | { kind: "signedOut" };

const STEP_CODES: Readonly<Record<string, StepRefusal>> = {
  zip_not_served: { step: "where", reason: "zipNotServed" },
  invalid_media: { step: "describe", reason: "invalidMedia" },
  invalid_intake_answers: { step: "questions", reason: "invalidAnswers" },
};

const SERVER_ERROR = 500;

/** Places a failed `POST /v1/requests` (its documented 422 codes, 429, 5xx, the network). */
export function sendFailureOf(error: unknown): SendFailure {
  if (error instanceof SessionExpiredError) return { kind: "signedOut" };
  if (!(error instanceof ApiError)) return { kind: "retry", reason: "failed" };
  const refusal = error.code ? STEP_CODES[error.code] : undefined;
  if (refusal) return { kind: "step", refusal };
  if (error.code === "rate_limited") return { kind: "retry", reason: "rateLimited" };
  if (error.status >= SERVER_ERROR) return { kind: "retry", reason: "failed" };
  return { kind: "rejected" };
}

type RequestParts = {
  draft: RequestDraft;
  category: Category;
  address: RequestCreate["address"];
  /** The finished uploads' keys, in the order the files were added. */
  mediaKeys: readonly string[];
};

/** The `RequestCreate` body: the answers by key, the media keys in order; no preferred date yet. */
export function requestBody({ draft, category, address, mediaKeys }: RequestParts): RequestCreate {
  return {
    category_id: category.id,
    description: draft.description.trim(),
    address,
    intake_answers: intakeAnswersFor(category.intake_questions, draft.answers),
    media_keys: [...mediaKeys],
  };
}
