# 0005. Stripe Connect with separate charges and transfers

- **Status:** accepted
- **Date:** 2026-10-16

Pros get Stripe Connect **Express** accounts, and payments use the **separate charges and
transfers** model. The customer pays when accepting a quote (PaymentIntent + Payment Sheet in
the app, with card, Apple Pay and Google Pay); the money stays on the platform balance. After
the customer confirms, or 48 h pass without a confirmation or dispute, the worker transfers the
amount minus the take rate to the pro's Express account. An open dispute blocks the transfer
until an admin releases it or refunds partially or fully.

Why: the product holds the payment until the service is confirmed (context §1), and a dispute
must be able to block the payout (§6). Charging on the platform and transferring after
confirmation does both.

## Consequences

- Webhooks are verified by signature and processed once (`webhook_events`).
- Every charge, transfer and refund uses an idempotency key.
- Amounts are integer cents computed only in the backend; job amounts are frozen at payment
  (`customer_price_cents`, `pro_payout_cents`, `platform_fee_cents`, `tax_cents`).
- The take rate and who absorbs Stripe fees are still pending (#2); code reads them from
  `settings`.
- Stripe stays in test mode until launch.
