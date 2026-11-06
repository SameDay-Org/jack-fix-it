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
- Associating a transfer with its charge is bookkeeping, not segregation of the customer's
  money: the charge still lands in the platform's one balance, which refunds, disputes, fees
  and other transfers also draw on. Stripe documents protected allocation of funds as a
  separate feature, funds segregation, in private preview; the MVP does not use it.
  [Separate charges and transfers](https://docs.stripe.com/connect/separate-charges-and-transfers?platform=web&integration=custom&ui=elements&api-integration=paymentintents)
  (introduction, the funds segregation note).
- What this means here: the transfer after confirmation (#68) carries `source_transaction` =
  the charge of the job's PaymentIntent (stored by #61) and the PaymentIntent's
  `transfer_group` (`request:<request id>`, set in #58). Stripe's exception above covers only a
  charge that has **not settled yet** when the transfer is created; after confirmation the
  charge has usually settled, and then the transfer is limited by the platform's available
  balance like any other, so it **can** fail for insufficient balance (after refunds,
  disputes or a payout of that balance, for example). #68 must handle that failure (no
  automatic retry by Stripe). The pro's own payout waits for the charge's settlement in either
  case.
- **Unverified** for #68, to confirm against Stripe before it ships: whether the platform's
  automatic payouts should be off or delayed so the available balance covers pending
  transfers, and how a transfer that failed for balance is retried.

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
- So funding a refund and recovering the money from the pro are separate operations. The
  refund is funded from the platform's balance whether or not the transfer was reversed.
  Recovery is the platform's to arrange, by a smaller later transfer or by a transfer reversal
  (entire or partial, `amount`), which moves the amount from the connected account back to the
  platform's available balance.
  [Refunds through a Connect platform](https://docs.stripe.com/refunds#refunds-through-a-connect-platform),
  [Separate charges and transfers, "Issue refunds" and "Reverse transfers"](https://docs.stripe.com/connect/separate-charges-and-transfers#reverse-transfers)
- A reversal can fail: it needs the connected account's available balance to cover it (or
  connected reserves), so a pro who already paid out their balance may leave nothing to
  reverse, while the platform can still fund the refund and carries the loss until it is
  recovered.
- Disputes (chargebacks) are debited from the platform's balance like refunds. A negative
  balance is offset by later payments; Stripe can also debit the platform's bank account for
  it (supported in the US).
  [Connect account balances](https://docs.stripe.com/connect/account-balances)

## What the MVP does with this

- The customer pays the quote's amount plus tax (0 in the MVP); the platform's 15% absorbs
  Stripe's fee (Cesar, 2026-10-29). A refund returns the customer's money; Stripe's fee stays
  paid by the platform.
- Before the transfer (#68), a refund (#69) draws on the platform's balance alone and nothing
  is owed back by the pro. After it, the refund is still funded by the platform; recovering
  the pro's share (a reversal, or a deduction from a later transfer) is a separate step that
  can fail. **Unconfirmed**: any sequencing between refund and recovery (for example reversing
  before refunding) is a policy for #69 / #74 to decide with Cesar (#3), not a Stripe rule.
- Amounts stay integer cents computed in the backend and frozen per payment and job (root
  `AGENTS.md`, "Money").
