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

Defined in D12.1 (#60). The backend state machine will be the single source of truth for the
internal states, their valid transitions and how each maps to a customer-visible status above.

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
