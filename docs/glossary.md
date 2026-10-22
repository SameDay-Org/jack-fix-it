# Glossary

Jack Fix It's domain language. Code, issues and UI copy use the English terms; the context doc
and the plan are in Portuguese, so the Portuguese word follows in parentheses where it differs.

## Customer-visible statuses

What the customer sees for a request or job. The label is the English UI copy; the key is the
i18n key apps use. Keys enter the locale files (EN and ES) with the first screen that shows a
status (D8.5, #47).

| Status                   | i18n key                                | Shown when                                          |
| ------------------------ | --------------------------------------- | --------------------------------------------------- |
| Request Received         | `customerStatus.requestReceived`        | The request was created.                            |
| Reviewing                | `customerStatus.reviewing`              | The BDC is classifying it or asking for more info.  |
| Finding a Pro            | `customerStatus.findingAPro`            | The request was sent to pros.                       |
| Quote Ready              | `customerStatus.quoteReady`             | There is a quote to approve.                        |
| Scheduled                | `customerStatus.scheduled`              | Paid, with a date set.                              |
| Professional On The Way  | `customerStatus.professionalOnTheWay`   | The pro marked "on the way".                        |
| In Progress              | `customerStatus.inProgress`             | The pro checked in.                                 |
| Waiting for Confirmation | `customerStatus.waitingForConfirmation` | The pro completed the job; the 48 h window is open. |
| Completed                | `customerStatus.completed`              | Confirmed and paid out to the pro.                  |
| Needs Attention          | `customerStatus.needsAttention`         | A problem is open or the customer must act.         |
| Cancelled                | `customerStatus.cancelled`              | Cancelled by either side.                           |

## Internal job states

The values stored in the `status` columns (#108). Decided 2026-10-21 by Cesar; derived from the
plan's job-state diagram (plan p. 12) and the customer-visible statuses above. Code never sets a
status directly: the backend state machine (D12.1, #60) changes them and writes `job_events`.

**Request** (`service_requests.status`)

| State         | Meaning                                                                  |
| ------------- | ------------------------------------------------------------------------ |
| `received`    | Created from the app, the web or by phone; nobody has handled it yet.    |
| `reviewing`   | The BDC is classifying it or asking for more information.                |
| `finding_pro` | Sent to pros; waiting for quotes.                                        |
| `quote_ready` | At least one quote waits for the customer's decision.                    |
| `accepted`    | The customer accepted a quote; the job is created when payment succeeds. |
| `expired`     | Closed without an accepted quote because it ran out of time.             |
| `cancelled`   | Cancelled by either side before a job exists.                            |

Request transitions and who may make each one live in
`apps/api/app/modules/requests/transitions.py` (D12.1, #160): `RequestStateMachine` applies them
and answers 409 `invalid_transition` otherwise. The terminal states are `expired` and
`cancelled`. Cesar approved four more edges on 2026-10-22:

- `quote_ready → finding_pro` (system): every quote was withdrawn or expired before the
  request's own deadline, so the request goes back out.
- `accepted → quote_ready` (system): the payment failed (#61); the customer can retry or pick
  another quote.
- `accepted → cancelled` (the customer who owns it, or staff): abandoned before paying; no money
  has moved.
- `finding_pro → reviewing` (staff): the BDC pulls the request back to reclassify it.

What the customer sees for a request, decided 2026-10-21 by Cesar. The mapping lives in
`apps/api/app/modules/requests/customer_status.py` and the API returns it as `customer_status`.
Once the request is paid, the job's status takes over (see the job mapping below).

| Request state | Customer sees                    |
| ------------- | -------------------------------- |
| `received`    | `customerStatus.requestReceived` |
| `reviewing`   | `customerStatus.reviewing`       |
| `finding_pro` | `customerStatus.findingAPro`     |
| `quote_ready` | `customerStatus.quoteReady`      |
| `accepted`    | `customerStatus.quoteReady`      |
| `expired`     | `customerStatus.cancelled`       |
| `cancelled`   | `customerStatus.cancelled`       |

`accepted` keeps the quote screen while the payment is pending.

**Quote** (`quotes.status`)

| State       | Meaning                                          |
| ----------- | ------------------------------------------------ |
| `pending`   | Sent to the customer, who has not decided yet.   |
| `accepted`  | The customer accepted it; payment follows.       |
| `rejected`  | The customer declined it.                        |
| `expired`   | Its `expires_at` passed without a decision.      |
| `withdrawn` | The pro withdrew it before the customer decided. |

**Job** (`jobs.status`). A job is created when the payment succeeds (`payment_intent.succeeded`),
so there is no unpaid state.

| State         | Meaning                                                                          |
| ------------- | -------------------------------------------------------------------------------- |
| `scheduled`   | Paid and held, with a date set.                                                  |
| `on_the_way`  | The pro marked "on the way".                                                     |
| `in_progress` | The pro checked in (check-in and photos).                                        |
| `completed`   | Done by the pro (after photos); the customer's 48 h confirmation window is open. |
| `confirmed`   | Confirmed by the customer, or automatically after 48 h; the transfer is pending. |
| `paid_out`    | The transfer to the pro was created, after a full or partial release.            |
| `disputed`    | The customer opened a problem; the transfer is blocked until an admin decides.   |
| `refunded`    | Fully refunded after an admin decision.                                          |
| `cancelled`   | Cancelled by either side.                                                        |

Job transitions, who may make each one, and the customer-visible mapping live in
`apps/api/app/modules/jobs/transitions.py` (D12.1, #60): `JobStateMachine` applies them, writes
a `job_events` row for every change and answers 409 `invalid_transition` otherwise. The
terminal states are `paid_out`, `refunded` and `cancelled`.

| Job state               | Customer sees                           |
| ----------------------- | --------------------------------------- |
| `scheduled`             | `customerStatus.scheduled`              |
| `on_the_way`            | `customerStatus.professionalOnTheWay`   |
| `in_progress`           | `customerStatus.inProgress`             |
| `completed`             | `customerStatus.waitingForConfirmation` |
| `confirmed`, `paid_out` | `customerStatus.completed`              |
| `disputed`              | `customerStatus.needsAttention`         |
| `refunded`, `cancelled` | `customerStatus.cancelled`              |

`refunded` shows as Cancelled: decided 2026-10-21 by Cesar.

## Roles

**customer**: a person who requests a service.

**pro**: a professional who quotes and performs services. Only approved pros with an active
Stripe account (`payouts_enabled`) receive requests.

**agent**: a BDC team member. Uses the admin/BDC panel only.

**admin**: approves pros, resolves disputes and takes financial actions. Uses the panel only.

## Terms

**BDC**: the support team that answers new requests in under 5 minutes, qualifies them,
matches pros by hand when needed and follows each job to the end.

**Request** (pedido): what the customer opens: what happened, photos or video, optional
category, location and date. It is also the BDC queue item. Identified to people by its public
code, e.g. `JF-000124`.

**Dispatch**: sending a request to up to N eligible pros of its category and ZIP.

**Quote** (orçamento): a pro's fixed price for a request, with what is included, duration and
proposed date. Expires after a configurable time.

**Job**: an accepted and paid quote. Its amounts are frozen at payment.

**Confirmation window**: the 48 h after the pro completes a job, during which the customer
confirms or reports a problem; with no action, the job is confirmed automatically.

**Dispute** (disputa): a problem the customer opens on a job. It blocks the transfer until an
admin releases it or refunds partially or fully.

**Transfer** (repasse): the payment from the platform balance to the pro's Stripe Express
account: job amount minus the take rate.

**Take rate**: the platform's percentage of each completed job. Value pending (#2).

**Service area**: a region → city → ZIP entry stored in the database; it decides where requests
are accepted and which pros are eligible.

**Warranty window**: internal name for the period in which a customer can report a problem.
Length and wording pending (#4); never used in customer-facing copy.

**GMV**: gross merchandise value, the total amount transacted.

**PITR**: point-in-time recovery of the Postgres database.
