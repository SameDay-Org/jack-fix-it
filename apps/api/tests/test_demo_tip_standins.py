"""The demo seed's Stripe stand-ins hold up a tip's payment and transfer (#518, the Vault's money
pass): what they answer reads as the real Stripe's would, so a demo tip is sent to its pro, not
held for staff as a stranger's transfer."""

import uuid
from datetime import timedelta

from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.jobs.models import JobStatus
from app.modules.payments.service import transfer_group
from app.modules.tips.models import Tip, TipChoice, TipStatus, TipTransferStatus
from app.modules.tips.transfers import TipTransferOutcome, TipTransferService
from tests.job_world import JobWorld, make_job
from tests.test_demo_seed import DEMO_DIR
from tests.test_tip_transfers import CUSTOMER, TIP, Clock, clock, tip_row, world
from tests.test_transfers import CONFIG, NOW, add_payment

__all__ = ["DEMO_DIR", "clock", "world"]  # the seed's import root, and fixtures by name

from demo_seed.stripe_standins import StandInPayments, StandInTransfers


async def test_a_tip_paid_on_the_stand_ins_is_sent_to_its_pro_not_held(
    db_session: AsyncSession, world: JobWorld, clock: Clock
) -> None:
    payments, transfers = StandInPayments(), StandInTransfers()
    job = await make_job(
        db_session, world, JobStatus.CONFIRMED, confirmed_at=NOW - timedelta(hours=2)
    )
    await add_payment(db_session, world, job)
    tip_id = uuid.uuid4()
    # The tip's intent as the tips' create makes it (its metadata), then paid in the app.
    intent = await payments.create_payment_intent(
        amount_cents=TIP,
        currency="usd",
        customer_id=CUSTOMER,
        transfer_group=transfer_group(job.request_id),
        metadata={"kind": "tip", "tip_id": str(tip_id), "job_id": str(job.id), "attempt": "1"},
        idempotency_key=f"tip:{tip_id}:1",
    )
    await payments.charge(intent.payment_intent_id)
    db_session.add(
        Tip(
            id=tip_id,
            job_id=job.id,
            request_id=job.request_id,
            customer_id=world.customer.id,
            pro_id=world.pro.profile_id,
            choice=TipChoice.CUSTOM,
            amount_cents=TIP,
            currency="usd",
            status=TipStatus.SUCCEEDED,
            succeeded_at=NOW - timedelta(hours=1),
            stripe_payment_intent_id=intent.payment_intent_id,
            attempt=1,
        )
    )
    await db_session.commit()

    outcome = await TipTransferService(db_session, payments, transfers, CONFIG, clock).release(
        tip_id
    )

    assert outcome is TipTransferOutcome.CREATED
    row = await tip_row(db_session, tip_id)
    assert row.transfer_status is TipTransferStatus.CREATED
    assert row.transfer_last_error_code is None
