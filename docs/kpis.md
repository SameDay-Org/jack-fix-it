# KPIs: the admin dashboard's metrics (#84, D16.5)

`GET /v1/admin/metrics?from=YYYY-MM-DD&to=YYYY-MM-DD&tz=` (agents and admins) returns the MVP
exit metrics over whole days in a time zone, both ends inclusive. The default is the last 30
days (`METRICS_DEFAULT_RANGE_DAYS`) ending today in `BUSINESS_TIME_ZONE`, and the longest range is
366 days (`METRICS_MAX_RANGE_DAYS`). A day runs from local midnight to local midnight, so a
daylight-saving day is 23 or 25 hours long.

Each figure carries a `formula` key; the panel prints the text below for it. A ratio comes with
its numerator and denominator ("12 of 40"), and is null when the denominator is 0. An average
with nothing to average is null, never 0. Every figure comes from one database snapshot.

| Key                      | Figure                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `first_response_minutes` | Requests created in the range that have a first contact by the BDC: the mean and the median of (first contact − creation), in minutes. Denominator: those requests.                                                                                                                                                                                                                                                           |
| `contact_rate`           | Requests created in the range that have a first contact (made at any time since) ÷ requests created in the range.                                                                                                                                                                                                                                                                                                             |
| `lead_to_job`            | Requests created in the range that have a job, whatever its status ÷ requests created in the range.                                                                                                                                                                                                                                                                                                                           |
| `completion_rate`        | Jobs created in the range (paid and scheduled) that reached "completed" (they have a completion time: confirmed, paid out, disputed and refunded jobs all passed through it) ÷ jobs created in the range. A job cancelled before it started stays in the denominator.                                                                                                                                                         |
| `customer_rating`        | The mean overall rating (1–5) of the reviews written in the range by pros about their customers, published or not.                                                                                                                                                                                                                                                                                                            |
| `pro_rating`             | The same for the reviews written by customers about their pros.                                                                                                                                                                                                                                                                                                                                                               |
| `dispute_rate`           | Problems reported (disputes opened) in the range ÷ jobs completed in the range (by completion time).                                                                                                                                                                                                                                                                                                                          |
| `repeat_rate`            | Among the customers with at least one job confirmed in the range, those with at least two jobs confirmed before the range's end.                                                                                                                                                                                                                                                                                              |
| `gmv`                    | What customers were charged (the job's frozen price plus tax) for the jobs confirmed in the range: gross, and confirmed jobs only. A job settled through a dispute was never confirmed and is not counted.                                                                                                                                                                                                                    |
| `revenue_net_of_refunds` | The fee the platform keeps (`refunds_netted` is true), over two cohorts that never share a job: the jobs confirmed in the range, their fee as frozen at payment; and the disputes an admin resolved in the range: a release keeps the job's fee, a full refund keeps nothing, and a partial keeps what its split left the platform (the customer's total minus the pro's part and the refund, as the resolution stored them). |

GMV and revenue cover different jobs on purpose: GMV is what customers paid for confirmed work,
revenue what the platform earned, disputes included. A disputed job is never confirmed (the job
state machine has no such path), so no job is counted twice. A refund's dispute is resolved only
once Stripe gave the money back (#76), so a refund Stripe has not finished leaves the revenue as
it was. Tax is 0 in the MVP; once tax is charged, its share of what a partial leaves the platform
must come out of the revenue.

Tips go to the pro in full, so neither GMV nor revenue would include them (the app has no tips
yet). The series gives, per day, the requests created, the jobs completed and the GMV of the jobs
confirmed that day.

The answer holds aggregates only: never a name, contact, address or id.
