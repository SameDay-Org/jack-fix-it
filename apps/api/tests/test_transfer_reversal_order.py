"""A transfer.reversed event and the release that stores the transfer, in either order (#68,
#416 round 1).

Stripe makes the transfer, its create answer is slow to come back, staff reverse it, and the
signed event goes through the real ingress and StripeEventProcessor on a connection of its own
before the release stores the transfer's id, or after it. Either way the row ends reversed, the
reversal is recorded once, and a redelivery changes nothing. The other connections commit for
real (committed_world)."""

import json
import logging
from dataclasses import replace
from typing import Any

import pytest
from sqlalchemy import select

from app.integrations.stripe_transfers import TransferFacts
from app.modules.jobs.models import Job, JobStatus
from app.modules.payments.models import Transfer, TransferStatus
from app.modules.payments.transfers import ReleaseOutcome
from app.modules.webhooks.models import WebhookEventStatus
from app.modules.webhooks.service import ProcessConfig, ProcessOutcome, StripeEventProcessor
from tests.test_stripe_webhooks_api import Webhook, event_body, settings, webhook
from tests.test_transfers import (
    Clock,
    CommittedWorld,
    FakeStripeTransfers,
    clock,
    committed_world,
    service,
    stripe,
)

__all__ = ["clock", "committed_world", "settings", "stripe", "webhook"]

PROCESS = ProcessConfig(max_attempts=3, retry_backoff_seconds=1)


@pytest.mark.parametrize("order", ["reversed_before_stored", "reversed_after_stored"])
async def test_a_reversal_holds_whether_its_event_comes_before_or_after_the_transfer_is_stored(
    committed_world: CommittedWorld,
    webhook: Webhook,
    stripe: FakeStripeTransfers,
    clock: Clock,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
    order: str,
) -> None:
    world = committed_world
    event_id = webhook.new_id()
    processed: list[ProcessOutcome] = []

    async def reverse(made: TransferFacts) -> None:
        """Staff reverse the transfer in Stripe; its signed event is received and processed."""
        stripe.transfers[made.transfer_id] = replace(made, reversed=True)
        body = json.loads(event_body(event_id, "transfer.reversed"))
        body["data"]["object"] = {
            "object": "transfer",
            "id": made.transfer_id,
            "reversed": True,
            "amount_reversed": made.amount_cents,
            "metadata": {"job_id": str(world.job_id)},
        }
        assert (await webhook.post(json.dumps(body).encode())).status_code == 200
        [event] = await webhook.rows(event_id)
        async with world.sessions() as session:
            result = await StripeEventProcessor(session, PROCESS).process(event.id, last_try=False)
        processed.append(result.outcome)

    create = stripe.create_transfer

    async def create_then_reverse(**kwargs: Any) -> TransferFacts:
        made = await create(**kwargs)
        if order == "reversed_before_stored":
            await reverse(made)
        # The create's own answer, from before the reversal: what the release stores.
        return made

    monkeypatch.setattr(stripe, "create_transfer", create_then_reverse)
    caplog.set_level(logging.INFO)

    async with world.sessions() as session:
        outcome = await service(session, stripe, clock).release(world.job_id)
    if order == "reversed_after_stored":
        await reverse(next(iter(stripe.transfers.values())))

    [event] = await webhook.rows(event_id)
    async with world.sessions() as session:
        redelivered = await StripeEventProcessor(session, PROCESS).process(event.id, last_try=False)
        row = (await session.scalars(select(Transfer).where(Transfer.job_id == world.job_id))).one()
        job_status = await session.scalar(select(Job.status).where(Job.id == world.job_id))

    assert outcome is ReleaseOutcome.CREATED
    assert processed == [ProcessOutcome.PROCESSED]
    assert (event.status, redelivered.outcome) == (
        WebhookEventStatus.PROCESSED,
        ProcessOutcome.SKIPPED,
    )
    assert (row.status, job_status, len(stripe.creates)) == (
        TransferStatus.REVERSED,
        JobStatus.PAID_OUT,
        1,
    )
    # Recorded once: by the release's re-read when the event came first, else by the event.
    assert [r.getMessage() for r in caplog.records].count("transfer_reversed") == 1
