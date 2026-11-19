/**
 * Tips at confirmation (#273): the one module that talks to the tips API.
 *
 * CONTRACT FIRST. The endpoint and the shapes below follow `handoffs/273-62-draft-spec.md` (API PR
 * A1) until the API's generated types merge. Then the `declare module` block and the local types
 * go, replaced by the generated schemas (`ApiSchema<"TipOut">`, ...), and `tipOf` and
 * `earningTipCents` read the generated fields directly. Nothing else in the app names these paths
 * or fields, so the switch is a small diff here.
 */
import type { QueryClient } from "@tanstack/react-query";

import { apiPost } from "@/api";
import type { Earning } from "@/features/earnings/api";
import { customerJobQueryKey } from "@/features/jobs/api";
import type { CustomerJob } from "@/features/jobs/phase";
import type { PaymentSheetOut } from "@/features/payments/paymentStore";

/** The tip's state on the server; `null` while the customer has chosen nothing yet. */
export type TipStatus =
  "declined" | "requires_payment" | "processing" | "succeeded" | "failed" | "canceled";

export type TipChoice = "none" | "percent" | "custom";

/** A preset as the server computed it: the app shows these amounts and computes none. */
export type TipPreset = { percent: number; amount_cents: number };

export type TipOptions = {
  presets: TipPreset[];
  /** The custom amount's bounds, inclusive. */
  min_cents: number;
  max_cents: number;
};

/** The job's tip (`CustomerJob.tip`): null on a job that cannot take one. */
export type TipOut = {
  status: TipStatus | null;
  choice: TipChoice | null;
  percent: number | null;
  amount_cents: number;
  currency: string;
  options: TipOptions;
  /** Inside the tip window, on a job that takes one, with no tip paid yet. */
  can_tip: boolean;
  /** When the window closes (ISO 8601). */
  closes_at: string | null;
};

/** What the customer chose: the server validates it and computes the amount of a percent. */
export type TipCreate =
  | { choice: "none" }
  | { choice: "percent"; percent: number }
  | { choice: "custom"; amount_cents: number };

/** The tip, and the Payment Sheet's secrets for a tip to pay (none for "No tip"). */
export type TipCreateOut = { tip: TipOut; sheet: PaymentSheetOut | null };

/** The API's error codes for a tip (the `{error: {code, message}}` contract). */
export const TIP_ERRORS = {
  notAvailable: "tip_not_available",
  alreadyPaid: "tip_already_paid",
  inProgress: "tip_in_progress",
  outOfRange: "tip_amount_out_of_range",
  percentNotOffered: "tip_percent_not_offered",
} as const;

type TipPath = {
  parameters: {
    query?: never;
    header?: never;
    path: { request_id: string };
    cookie?: never;
  };
  get?: never;
  put?: never;
  post: {
    parameters: {
      query?: never;
      header?: never;
      path: { request_id: string };
      cookie?: never;
    };
    requestBody: { content: { "application/json": TipCreate } };
    responses: {
      200: { headers: Record<string, unknown>; content: { "application/json": TipCreateOut } };
    };
  };
  delete?: never;
  options?: never;
  head?: never;
  patch?: never;
  trace?: never;
};

declare module "@jack/shared" {
  // CONTRACT (#273, PR A1): goes when the generated `paths` has this entry.
  interface paths {
    "/v1/requests/{request_id}/job/tip": TipPath;
  }
}

/** The job's tip, or null (a job that cannot take one, or an API without tips yet). */
export function tipOf(job: CustomerJob): TipOut | null {
  // CONTRACT: `CustomerJob.tip` once A1's types merge.
  return (job as CustomerJob & { tip?: TipOut | null }).tip ?? null;
}

/** The pro's tip on an earnings row, in cents; 0 when none (#273, PR A2's `tip_cents`). */
export function earningTipCents(item: Earning): number {
  // CONTRACT: `EarningsItem.tip_cents` once A2's types merge.
  return (item as Earning & { tip_cents?: number }).tip_cents ?? 0;
}

/** Sends the customer's choice for the job of `requestId`, pinned to the session that made it. */
export function sendTip(
  requestId: string,
  choice: TipCreate,
  generation: number,
): Promise<TipCreateOut> {
  return apiPost("/v1/requests/{request_id}/job/tip", choice, {
    auth: true,
    generation,
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
    // CONTRACT: `CustomerJob.tip` once A1's types merge.
    job ? ({ ...job, tip } as CustomerJob) : job,
  );
}
