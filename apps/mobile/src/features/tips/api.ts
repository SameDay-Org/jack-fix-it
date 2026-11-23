/**
 * Tips at confirmation (#273): the one module that talks to the tips API
 * (`POST /v1/requests/{request_id}/job/tip`, `CustomerJob.tip`, `EarningsItem.tip_cents`).
 */
import type { ApiSchema } from "@jack/shared";
import type { QueryClient } from "@tanstack/react-query";

import { apiPost } from "@/api";
import type { Earning } from "@/features/earnings/api";
import { customerJobQueryKey } from "@/features/jobs/api";
import type { CustomerJob } from "@/features/jobs/phase";

/** The tip's state on the server; `null` while the customer has chosen nothing yet. */
export type TipStatus = ApiSchema<"TipStatus">;

/** The job's tip (`CustomerJob.tip`): null on a job that cannot take one. */
export type TipOut = ApiSchema<"TipOut">;

/** What the customer chose: the server validates it and computes the amount of a percent. */
export type TipCreate = ApiSchema<"NoTipIn"> | ApiSchema<"PercentTipIn"> | ApiSchema<"CustomTipIn">;

/** The tip, and the Payment Sheet's secrets for a tip to pay (none for "No tip"). */
export type TipCreateOut = ApiSchema<"TipCreateOut">;

/** The API's error codes for a tip (the `{error: {code, message}}` contract). */
export const TIP_ERRORS = {
  notAvailable: "tip_not_available",
  alreadyPaid: "tip_already_paid",
  inProgress: "tip_in_progress",
  needsReview: "tip_needs_review",
  keyReused: "idempotency_key_reused",
  outOfRange: "tip_amount_out_of_range",
  percentNotOffered: "tip_percent_not_offered",
} as const;

/** The job's tip, or null (a job that cannot take one). */
export function tipOf(job: CustomerJob): TipOut | null {
  return job.tip ?? null;
}

/** The pro's tip on an earnings row, in cents; 0 when none. */
export function earningTipCents(item: Earning): number {
  return item.tip_cents ?? 0;
}

/**
 * Sends the customer's choice for the job of `requestId`, pinned to the session that made it.
 * `idempotencyKey` is made once per choice and sent again with every retry of it: a retry the
 * server already settled answers what it settled instead of doing it twice.
 */
export function sendTip(
  requestId: string,
  choice: TipCreate,
  options: { generation: number; idempotencyKey: string },
): Promise<TipCreateOut> {
  return apiPost("/v1/requests/{request_id}/job/tip", choice, {
    auth: true,
    generation: options.generation,
    idempotencyKey: options.idempotencyKey,
    params: { request_id: requestId },
  });
}

/**
 * Puts the API's answer for the tip on the cached job at once, so the card never reads an earlier
 * attempt's status (a failed one) while the new attempt is under way.
 */
export function rememberTip(
  client: QueryClient,
  requestId: string,
  generation: number,
  tip: TipOut,
): void {
  client.setQueryData<CustomerJob>(customerJobQueryKey(requestId, generation), (job) =>
    job ? { ...job, tip } : job,
  );
}
