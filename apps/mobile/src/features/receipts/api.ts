/**
 * The receipt (#62): the one module that talks to the receipt API.
 *
 * CONTRACT FIRST. The endpoint and the shapes below follow `handoffs/273-62-draft-spec.md` (API PR
 * C, with the Foreman's decisions) until the API's generated types merge. Then the `declare
 * module` block and the local types go, replaced by the generated schemas (`ApiSchema<
 * "ReceiptOut">`, ...). Nothing else in the app names this path or these fields, so the switch is
 * a small diff here.
 */
import { queryOptions, useQuery } from "@tanstack/react-query";

import { apiGet, useSessionGeneration } from "@/api";

/**
 * Where the receipt's money stands: `paid`; `under_review` (a reported problem is open);
 * `partly_returned` (some went back to the payment method); `returned` (all of it did).
 */
export type ReceiptStatus = "paid" | "under_review" | "partly_returned" | "returned";

/**
 * One line, from the frozen amounts: the service, the tax (only when there is some), the tip
 * (once it went through) and each amount that went back (negative, dated). Never the platform's
 * fee: the customer pays the total.
 */
export type ReceiptLine = {
  kind: "service" | "tax" | "tip" | "returned";
  /** Integer cents; negative for an amount returned. */
  amount_cents: number;
  /** When it happened, for a returned amount; null otherwise. */
  at: string | null;
};

export type ReceiptOut = {
  /** The request's public code (JF-000124): one receipt per job. */
  receipt_number: string;
  paid_at: string;
  status: ReceiptStatus;
  category: { slug: string; names: Record<string, string> } | null;
  /** "Dan R." */
  pro_name: string;
  scheduled_start_at: string;
  completed_at: string | null;
  /** The customer's own address, line 1 and city (the receipt on screen only). */
  address: { line1: string; city: string; state: string } | null;
  lines: ReceiptLine[];
  total_paid_cents: number;
  currency: string;
  /** "Visa •••• 4242", or the wallet that carried it; null for a payment without details. */
  payment_method: { brand: string | null; last4: string | null; wallet: string | null } | null;
  /** Whether a tip can still be added, and until when (#273). */
  tip: { can_tip: boolean; closes_at: string | null } | null;
  /** Who issues the receipt (Q-R1): values from the API's settings, never from the app. */
  issuer: { legal_name: string; support_email: string };
};

type ReceiptPath = {
  parameters: {
    query?: never;
    header?: never;
    path: { request_id: string };
    cookie?: never;
  };
  get: {
    parameters: {
      query?: never;
      header?: never;
      path: { request_id: string };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      200: { headers: Record<string, unknown>; content: { "application/json": ReceiptOut } };
    };
  };
  put?: never;
  post?: never;
  delete?: never;
  options?: never;
  head?: never;
  patch?: never;
  trace?: never;
};

declare module "@jack/shared" {
  // CONTRACT (#62, PR C): goes when the generated `paths` has this entry.
  interface paths {
    "/v1/requests/{request_id}/receipt": ReceiptPath;
  }
}

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
