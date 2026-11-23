/**
 * The receipt (#62): the one module that talks to the receipt API
 * (`GET /v1/requests/{request_id}/receipt`).
 */
import type { ApiSchema } from "@jack/shared";
import { queryOptions, useQuery } from "@tanstack/react-query";

import { apiGet, useSessionGeneration } from "@/api";

/**
 * Where the receipt's money stands: `paid`; `under_review` (a reported problem is open);
 * `partly_returned` (some went back to the payment method); `returned` (all of it did).
 */
export type ReceiptStatus = ApiSchema<"ReceiptStatus">;

/**
 * One line, from the frozen amounts: the service, the tax (only when there is some), the tip
 * (once it went through) and each amount that went back (negative, dated). Never the platform's
 * fee: the customer pays the total.
 */
export type ReceiptLine = ApiSchema<"ReceiptLine">;

/**
 * The receipt. `issuer` (who issues it, from the API's settings, Q-R1) and `pro_name` can be null:
 * the paper then leaves those lines out rather than make anything up.
 */
export type ReceiptOut = ApiSchema<"ReceiptOut">;

/** Not there yet: the job's payment has not gone through (404 `receipt_not_available`). */
export const RECEIPT_NOT_AVAILABLE = "receipt_not_available";

export const receiptQueryKey = (requestId: string, generation: number) =>
  ["receipt", requestId, generation] as const;

export const receiptQueryOptions = (requestId: string, generation: number) =>
  queryOptions({
    queryKey: receiptQueryKey(requestId, generation),
    queryFn: ({ signal }) =>
      apiGet("/v1/requests/{request_id}/receipt", {
        auth: true,
        signal,
        generation,
        params: { request_id: requestId },
      }),
    retry: false,
  });

/** The receipt of the request's job, for the session on screen. */
export const useReceipt = (requestId: string) =>
  useQuery(receiptQueryOptions(requestId, useSessionGeneration()));
