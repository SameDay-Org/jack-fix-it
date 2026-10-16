# 0006. No card pre-authorization

- **Status:** accepted
- **Date:** 2026-10-16

We charge the full amount when the customer accepts the quote and hold it on the platform
balance (ADR 0005). We do **not** pre-authorize the card: a pre-authorization expires within a
few days, and a job can be scheduled weeks ahead. Charging and holding works for any lead time.
