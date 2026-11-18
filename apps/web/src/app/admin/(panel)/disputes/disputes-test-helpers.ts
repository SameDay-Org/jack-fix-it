/** Fixtures of the disputes page tests: disputes as the API returns them. Tests only. */
import type { components } from "@jack/shared";

import type { Dispute, DisputeItem, Refund } from "./disputes";

export const DISPUTE_ID = "2a7d0c4e-1111-4222-8333-944455556666";
export const JOB_ID = "7b2d9e4a-5555-4666-8777-188899990000";
export const PHOTO_ID = "9c4e2a7d-3333-4444-8555-666677778888";
export const CODE = "JFX-7Q2K";
/** The signed address of the photo's safe copy: it must never reach the browser. */
export const SIGNED_URL =
  "https://storage.test.invalid/safe/u/photo.jpg?X-Amz-Signature=probe-9931";
/** Text with markup and a script sentinel: it must show as text, never run. */
export const REPORT = 'The tap still leaks.\n<script>alert("x")</script> <b>bold</b>';
export const REPLY = "I fixed the washer; it was dry when I left.";

/** Now, for the age tests: 2026-11-18 12:00 UTC. */
export const NOW = Date.parse("2026-11-18T12:00:00Z");

export function hoursAgo(hours: number): string {
  return new Date(NOW - hours * 3_600_000).toISOString();
}

export function summary(extra: Partial<DisputeItem> = {}): DisputeItem {
  return {
    id: DISPUTE_ID,
    job_id: JOB_ID,
    public_code: CODE,
    status: "open",
    reason_code: "work_incomplete",
    resolution: null,
    job_status: "disputed",
    customer_first_name: "Jamie",
    pro_first_name: "Dan",
    customer_total_cents: 13_250,
    pro_payout_cents: 10_000,
    pro_release_cents: null,
    customer_refund_cents: null,
    currency: "usd",
    opened_at: hoursAgo(3),
    resolved_at: null,
    ...extra,
  };
}

export function refund(extra: Partial<Refund> = {}): Refund {
  return {
    id: "4e2a7d0c-2222-4333-8444-555566667777",
    amount_cents: 13_250,
    currency: "usd",
    status: "created",
    stripe_refund_id: "re_probe",
    attempts: 1,
    last_error_code: null,
    requested_at: hoursAgo(1),
    ...extra,
  };
}

type Payment = components["schemas"]["PaymentSummaryOut"];

export function payment(extra: Partial<Payment> = {}): Payment {
  return {
    id: "5f0e3c1a-3333-4444-8555-666677778888",
    amount_cents: 12_500,
    tax_cents: 750,
    customer_total_cents: 13_250,
    platform_fee_cents: 2_500,
    pro_payout_cents: 10_000,
    currency: "usd",
    status: "succeeded",
    ...extra,
  };
}

export function dispute(extra: Partial<Dispute> = {}): Dispute {
  return {
    ...summary(),
    description: REPORT,
    pro_reply: REPLY,
    pro_replied_at: hoursAgo(2),
    resolution_note: null,
    resolved_by: null,
    photos: [
      {
        id: PHOTO_ID,
        content_type: "image/jpeg",
        url: SIGNED_URL,
        expires_at: hoursAgo(-1),
      },
    ],
    photos_pending: 0,
    events: [
      {
        type: "status_changed",
        from_status: "in_progress",
        to_status: "completed",
        by_system: false,
        created_at: hoursAgo(30),
      },
      {
        type: "status_changed",
        from_status: "completed",
        to_status: "disputed",
        by_system: false,
        created_at: hoursAgo(3),
      },
    ],
    payment: payment(),
    refund: null,
    transfer: null,
    ...extra,
  };
}
