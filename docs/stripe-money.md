# Stripe money on a US platform (#57)

Short notes for D11 (the payment at acceptance, #58), the transfer after confirmation (#68) and
refunds (#69, #74), read with ADR 0005 (separate charges and transfers). Each fact links to the
Stripe page it comes from, as read on 2026-11-06. Anything not confirmed there is marked so.

## When charged funds become available

- Every Stripe account, the platform's and each connected account, has a `pending` and an
  `available` balance. A charge, minus Stripe's fee, lands in `pending` and becomes `available`
  after the settlement period: "becomes available in 2 days on a rolling basis (this timing
  varies by country and account)". Only `available` funds can be paid out or transferred.
  [Connect account balances](https://docs.stripe.com/connect/account-balances)
- United States: the initial settlement timing is 2 business days (the payouts page's
  per-country table). Stripe may keep an account on a longer timing for risk reasons.
  [Payouts](https://docs.stripe.com/payouts)
- New accounts: after the first successful live payment, Stripe "typically schedules your first
  payout to complete in 7 to 14 days, depending on your industry, country of operation and
  risk level". [Payouts](https://docs.stripe.com/payouts)
- With separate charges and transfers, the platform's balance "is debited for the cost of the
  Stripe fees, refunds, and chargebacks".
  [Separate charges and transfers](https://docs.stripe.com/connect/separate-charges-and-transfers)

## A transfer before the funds are available: `source_transaction`

- "By default, a transfer request fails when the amount exceeds the platform's available
  account balance. Stripe doesn't automatically retry failed transfer requests." Adding funds
  later does not retry it either.
- A transfer tied to its charge with `source_transaction` (the charge id, set at creation and
  never updatable) "returns success regardless of your available balance if the related charge
  hasn't settled yet. However, the funds don't become available in the destination account
  until the funds from the associated charge are available to transfer from the platform
  account." Several transfers may share one `source_transaction` "as long as the sum of the
  transfers doesn't exceed the source charge", and the transfer "takes on the pending status of
  the associated charge". If the charge has a `transfer_group`, the transfer gets the same one.
- "Automatic payouts can interfere with transfers that don't have a defined
  `source_transaction`": a payout of the platform's available balance can leave nothing for
  an untied transfer.
- All of the above: [Separate charges and transfers, "Transfer availability"](https://docs.stripe.com/connect/separate-charges-and-transfers#transfer-availability).
- What this means here: the transfer after confirmation (#68) carries `source_transaction` =
  the charge of the job's PaymentIntent (stored by #61) and the PaymentIntent's
  `transfer_group` (`request:<request id>`, set in #58), so it never fails on the platform's
  available balance and never draws on another customer's money. The pro's own payout then
  waits for that charge's settlement, which the 48 h confirmation window usually covers.

## Payout schedule basics

- A payout schedule says when Stripe sends `available` funds to the bank account: manual,
  daily (every business day), or on chosen days of the week or month; a payout due on a
  weekend or holiday arrives the next business day. The schedule does not change when
  `pending` funds become `available`; it only controls when payouts are sent.
  [Payouts](https://docs.stripe.com/payouts)
- Express accounts (the pros', D7.1) have their own schedules. The platform may set
  `delay_days` on them, counted in business days for US accounts
  ([Payouts](https://docs.stripe.com/payouts)); how long a pending balance is held before a
  payout depends on that setting
  ([Separate charges and transfers](https://docs.stripe.com/connect/separate-charges-and-transfers)).
  The MVP leaves Stripe's defaults.

## Refund rules

- A refund is full or partial, and more than one may be issued "but you can't refund a total
  greater than the original charge amount". Stripe's processing fees for the original
  transaction are not returned. Refunds come out of the `available` balance (not `pending`);
  when it cannot cover one, Stripe keeps a card refund pending until it can. The customer sees
  the credit 5 to 10 business days later; a refund issued right after the charge may post as a
  reversal (the charge disappears from the statement, no separate credit).
  [Refund and cancel payments](https://docs.stripe.com/refunds)
- Window: Stripe's refunds page states no time limit for card refunds. Card networks do limit
  how old a refunded charge may be (commonly quoted as 180 days): **unconfirmed**, confirm with
  Stripe support before promising a refund past the 48 h confirmation window (#3).
- On a platform with separate charges and transfers, the refund is debited from the platform,
  and "refunding a charge has no impact on any associated transfers. It's up to your platform
  to reconcile any amount owed back to it by reducing subsequent transfer amounts or by
  reversing transfers."
  [Separate charges and transfers, "Issue refunds"](https://docs.stripe.com/connect/separate-charges-and-transfers#issue-refunds)
- A refund after the transfer therefore needs a transfer reversal first, entirely or partially
  (`amount`): it "adds the specified (or entire) amount back to the platform's available
  balance, reducing the connected account's available balance accordingly", and is only
  possible "if the connected account's available balance is greater than the reversal amount
  or has connected reserves enabled". Reversals are for refunds or disputes related to the
  charge, or to correct a transfer.
  [Separate charges and transfers, "Reverse transfers"](https://docs.stripe.com/connect/separate-charges-and-transfers#reverse-transfers)
- Disputes (chargebacks) are debited from the platform's balance like refunds. A negative
  balance is offset by later payments; Stripe can also debit the platform's bank account for
  it (supported in the US).
  [Connect account balances](https://docs.stripe.com/connect/account-balances)

## What the MVP does with this

- The customer pays the quote's amount plus tax (0 in the MVP); the platform's 15% absorbs
  Stripe's fee (Cesar, 2026-10-29). A refund returns the customer's money; Stripe's fee stays
  paid by the platform.
- Before the transfer (#68), a refund (#69) draws on the platform's balance alone. After it,
  reverse the transfer first; the pro's Express balance must still hold the amount.
- Amounts stay integer cents computed in the backend and frozen per payment and job (root
  `AGENTS.md`, "Money").
