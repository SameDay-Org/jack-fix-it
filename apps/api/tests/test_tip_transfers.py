"""A tip's transfer to its pro (#273 PR A2): TipTransferService.release, its sweep and reversal
check, the transfer.reversed webhook for a tip's transfer, and the job transfer's guard.

Stripe is two fakes: the payment calls' (the tip's PaymentIntent and charge, as Stripe holds
them) and the transfer calls' (test_transfers.py: the same idempotency key gets the same
transfer back, and a lost answer still makes it). The rolled-back test session, its fixture rows
committed first: a release ends its transactions.
"""

import logging
import uuid
from datetime import timedelta
from typing import Any

import pytest
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.integrations.stripe_errors import StripeRejectedError, StripeUnavailableError
from app.integrations.stripe_payments import TipIntentFacts
from app.integrations.stripe_transfers import TransferFacts
from app.modules.disputes.models import Dispute, DisputeReason, DisputeResolution, DisputeStatus
from app.modules.jobs.models import Job, JobStatus
from app.modules.payments.models import Payment, Refund, RefundStatus, Transfer
from app.modules.payments.service import transfer_group
from app.modules.payments.transfers import ReleaseOutcome, ReversalCheckOutcome, TransferService
from app.modules.pros.models import ProProfile, ProVerificationStatus
from app.modules.tips import transfers as tip_transfers
from app.modules.tips.models import Tip, TipChoice, TipStatus, TipTransferStatus
from app.modules.tips.transfer_tasks import (
    check_tip_transfer_reversals,
    release_succeeded_tips,
    release_tip_transfer,
)
from app.modules.tips.transfers import (
    JOB_REFUNDED_OR_DISPUTED,
    LATE_SUCCESS,
    PAYOUTS_NOT_ENABLED,
    PRO_NOT_APPROVED,
    TIP_CHARGE_NOT_PAYABLE,
    TIP_TRANSFER_NEEDS_REVIEW,
    TIP_TRANSFER_REFUSED,
    TipTransferOutcome,
    TipTransferService,
)
from app.modules.users.models import User
from app.modules.webhooks.events import AfterCommit, StripeEvent
from app.modules.webhooks.handlers import handler_for
from tests.conftest import make_settings
from tests.job_world import JobWorld, build_world, job_row, make_job
from tests.test_payments_api import TIP_CHARGE, FakeStripePayments
from tests.test_transfers import (
    ACCOUNT,
    CONFIG,
    NOW,
    Clock,
    FakeStripeTransfers,
    add_payment,
    ref,
    reversed_event,
    worker_ctx,
)

__all__ = ["Clock"]

TIP = 1_250
CUSTOMER = "cus_probe273a2"
# Stripe objects the fakes hold; none may reach a log, nor the amount.
LEAKS = (ACCOUNT, TIP_CHARGE, CUSTOMER, "tr_probe68", "pi_probe273a2", str(TIP))


async def committed_tip(
    session: AsyncSession, world: JobWorld, payments: FakeStripePayments, **fields: Any
) -> tuple[uuid.UUID, uuid.UUID, uuid.UUID]:
    """A confirmed job with its payment and a succeeded tip, committed, which Stripe holds as
    succeeded: (tip id, job id, request id)."""
    job = await make_job(session, world, JobStatus.CONFIRMED, confirmed_at=NOW - timedelta(hours=2))
    await add_payment(session, world, job)
    values: dict[str, Any] = {
        "job_id": job.id,
        "request_id": job.request_id,
        "customer_id": world.customer.id,
        "pro_id": world.pro.profile_id,
        "choice": TipChoice.CUSTOM,
        "amount_cents": TIP,
        "currency": "usd",
        "status": TipStatus.SUCCEEDED,
        "succeeded_at": NOW - timedelta(hours=1),
        "stripe_payment_intent_id": f"pi_probe273a2{uuid.uuid4().hex[:8]}",
        "attempt": 1,
        **fields,
    }
    tip = Tip(**values)
    session.add(tip)
    await session.flush()
    ids = (tip.id, job.id, job.request_id)
    intent = tip.stripe_payment_intent_id
    await session.commit()
    if intent is not None:
        payments.add_tip_intent(
            TipIntentFacts(
                payment_intent_id=intent,
                amount_cents=TIP,
                currency="usd",
                customer_id=CUSTOMER,
                status="succeeded",
                failed=False,
                kind="tip",
                tip_id=str(ids[0]),
                job_id=str(ids[1]),
                attempt="1",
            )
        )
        payments.tip_statuses[intent] = "succeeded"
    return ids


@pytest.fixture
async def world(db_session: AsyncSession) -> JobWorld:
    built = await build_world(db_session)
    await db_session.execute(
        update(ProProfile)
        .where(ProProfile.id == built.pro.profile_id)
        .values(stripe_account_id=ACCOUNT, payouts_enabled=True)
    )
    await db_session.execute(
        update(User).where(User.id == built.customer.id).values(stripe_customer_id=CUSTOMER)
    )
    await db_session.commit()
    return built


@pytest.fixture
def payments() -> FakeStripePayments:
    return FakeStripePayments()


@pytest.fixture
def stripe() -> FakeStripeTransfers:
    return FakeStripeTransfers()


@pytest.fixture
def clock() -> Clock:
    return Clock()


def service(
    session: AsyncSession,
    payments: FakeStripePayments | None,
    stripe: FakeStripeTransfers | None,
    clock: Clock,
) -> TipTransferService:
    return TipTransferService(session, payments, stripe, CONFIG, clock)


async def tip_row(session: AsyncSession, tip_id: uuid.UUID) -> Tip:
    statement = select(Tip).where(Tip.id == tip_id).execution_options(populate_existing=True)
    return (await session.scalars(statement)).one()


def assert_no_leak(caplog: pytest.LogCaptureFixture) -> None:
    rendered = caplog.text + "".join(str(r.__dict__) for r in caplog.records)
    for leak in LEAKS:
        assert leak not in rendered, leak


def messages(caplog: pytest.LogCaptureFixture) -> list[str]:
    return [record.message for record in caplog.records]


# --- One transfer of the whole tip ----------------------------------------------------------


async def test_release_sends_the_whole_tip_once_from_its_own_charge(
    db_session: AsyncSession,
    world: JobWorld,
    payments: FakeStripePayments,
    stripe: FakeStripeTransfers,
    clock: Clock,
    caplog: pytest.LogCaptureFixture,
) -> None:
    caplog.set_level(logging.DEBUG)
    tip_id, job_id, request_id = await committed_tip(db_session, world, payments)

    outcome = await service(db_session, payments, stripe, clock).release(tip_id)
    again = await service(db_session, payments, stripe, clock).release(tip_id)

    assert (outcome, again) == (TipTransferOutcome.CREATED, TipTransferOutcome.ALREADY_CREATED)
    # The whole tip (Jack absorbs the card fee), from the tip's own charge, under its own key,
    # with no job id in its metadata.
    assert stripe.creates == [
        {
            "amount_cents": TIP,
            "currency": "usd",
            "destination": ACCOUNT,
            "transfer_group": transfer_group(request_id),
            "source_transaction": TIP_CHARGE,
            "metadata": {"kind": "tip", "tip_id": str(tip_id)},
            "idempotency_key": f"tip_transfer:{tip_id}",
        }
    ]
    row = await tip_row(db_session, tip_id)
    [made] = stripe.by_key.values()
    assert (row.transfer_status, row.stripe_transfer_id, row.transfer_attempts) == (
        TipTransferStatus.CREATED,
        made,
        1,
    )
    assert row.transfer_idempotency_key == f"tip_transfer:{tip_id}"
    assert row.transfer_reversal_checked_at is not None
    # Read from Stripe once per call that reached Stripe, and read again after the create.
    assert len(payments.tip_charge_reads) == 1
    assert stripe.retrieves == [made]
    # The job's own money flow is untouched: still confirmed, no transfer row of the job.
    assert (await job_row(db_session, job_id)).status is JobStatus.CONFIRMED
    assert await db_session.scalar(select(Transfer.id).where(Transfer.job_id == job_id)) is None
    assert "tip_transfer_created" in messages(caplog)
    assert_no_leak(caplog)


async def test_the_job_transfer_never_adopts_a_tip_transfer_in_its_group(
    db_session: AsyncSession, world: JobWorld, stripe: FakeStripeTransfers, clock: Clock
) -> None:
    """The spec's (d): the job's retry lists the request's group, where a tip's transfer sits,
    even one whose metadata names the job too; it is never the job's."""
    job = await make_job(
        db_session, world, JobStatus.CONFIRMED, confirmed_at=NOW - timedelta(hours=1)
    )
    payment = await add_payment(db_session, world, job)
    job_ref = ref(job)
    await db_session.commit()
    stripe.add(
        TransferFacts(
            transfer_id="tr_probe68tip",
            amount_cents=payment.pro_payout_cents,
            currency="usd",
            destination=ACCOUNT,
            job_id=str(job_ref.id),
            reversed=False,
            request_id=None,
            kind="tip",
            tip_id=str(uuid.uuid4()),
        ),
        transfer_group(job_ref.request_id),
    )
    jobs = TransferService(db_session, stripe, CONFIG, clock)
    stripe.errors["create"] = [StripeUnavailableError(request_id="req_down")]
    assert await jobs.release(job_ref.id) is ReleaseOutcome.FAILED
    clock.now += CONFIG.stuck_after

    assert await jobs.release(job_ref.id) is ReleaseOutcome.CREATED

    transfer = (
        await db_session.scalars(
            select(Transfer)
            .where(Transfer.job_id == job_ref.id)
            .execution_options(populate_existing=True)
        )
    ).one()
    assert transfer.stripe_transfer_id != "tr_probe68tip"
    assert [create["metadata"] for create in stripe.creates] == [{"job_id": str(job_ref.id)}]


async def test_a_tip_not_succeeded_sends_nothing(
    db_session: AsyncSession,
    world: JobWorld,
    payments: FakeStripePayments,
    stripe: FakeStripeTransfers,
    clock: Clock,
) -> None:
    tip_id, _, _ = await committed_tip(
        db_session, world, payments, status=TipStatus.REQUIRES_PAYMENT, succeeded_at=None
    )

    outcome = await service(db_session, payments, stripe, clock).release(tip_id)

    assert outcome is TipTransferOutcome.NOT_PAYABLE
    assert (stripe.creates, payments.tip_charge_reads) == ([], [])
    assert (await tip_row(db_session, tip_id)).transfer_status is TipTransferStatus.NONE
    assert tip_id not in await service(db_session, payments, stripe, clock).due(10_000)


async def test_without_stripe_nothing_is_sent(
    db_session: AsyncSession, world: JobWorld, payments: FakeStripePayments, clock: Clock
) -> None:
    tip_id, _, _ = await committed_tip(db_session, world, payments)

    assert await service(db_session, None, FakeStripeTransfers(), clock).release(tip_id) is (
        TipTransferOutcome.NOT_CONFIGURED
    )
    assert await service(db_session, payments, None, clock).release(tip_id) is (
        TipTransferOutcome.NOT_CONFIGURED
    )
    assert (await tip_row(db_session, tip_id)).transfer_status is TipTransferStatus.NONE


# --- Staff's: never sent by itself ----------------------------------------------------------


async def add_dispute(
    session: AsyncSession, world: JobWorld, job_id: uuid.UUID, status: DisputeStatus
) -> None:
    session.add(
        Dispute(
            job_id=job_id,
            opened_by=world.customer.id,
            reason_code=DisputeReason.DAMAGE,
            description="Tip hold probe",
            status=status,
            **(
                {
                    "resolution": DisputeResolution.RELEASED,
                    "resolved_by": world.admin.id,
                    "resolved_at": NOW,
                }
                if status is DisputeStatus.RESOLVED
                else {}
            ),
        )
    )
    await session.commit()


async def add_refund(session: AsyncSession, job_id: uuid.UUID, status: RefundStatus) -> None:
    payment_id = await session.scalar(
        select(Payment.id).join(Job, Job.quote_id == Payment.quote_id).where(Job.id == job_id)
    )
    assert payment_id is not None
    session.add(
        Refund(
            job_id=job_id,
            payment_id=payment_id,
            amount_cents=500,
            currency="usd",
            idempotency_key=f"cancel:{uuid.uuid4()}:refund",
            status=status,
            requested_at=NOW,
        )
    )
    await session.commit()


@pytest.mark.parametrize(
    "hold",
    ["open_dispute", "resolved_dispute", "pending_refund", "failed_refund", "late_success"],
)
async def test_a_refunded_or_disputed_job_or_a_flagged_tip_is_staffs(
    db_session: AsyncSession,
    world: JobWorld,
    payments: FakeStripePayments,
    stripe: FakeStripeTransfers,
    clock: Clock,
    caplog: pytest.LogCaptureFixture,
    hold: str,
) -> None:
    tip_id, job_id, _ = await committed_tip(
        db_session,
        world,
        payments,
        **({"late_success_at": NOW} if hold == "late_success" else {}),
    )
    if hold.endswith("dispute"):
        opened = DisputeStatus.OPEN if hold == "open_dispute" else DisputeStatus.RESOLVED
        await add_dispute(db_session, world, job_id, opened)
    elif hold.endswith("refund"):
        refund = RefundStatus.PENDING if hold == "pending_refund" else RefundStatus.FAILED
        await add_refund(db_session, job_id, refund)
    # Never tried yet, and already out of the sweep's reach.
    assert tip_id not in await service(db_session, payments, stripe, clock).due(10_000)

    outcome = await service(db_session, payments, stripe, clock).release(tip_id)

    assert outcome is TipTransferOutcome.NEEDS_REVIEW
    row = await tip_row(db_session, tip_id)
    code = LATE_SUCCESS if hold == "late_success" else JOB_REFUNDED_OR_DISPUTED
    assert (row.transfer_status, row.transfer_last_error_code) == (TipTransferStatus.HELD, code)
    assert (stripe.creates, stripe.lists, payments.tip_charge_reads) == ([], [], [])
    assert [r.levelno for r in caplog.records if r.message == "tip_transfer_needs_review"] == [
        logging.ERROR
    ]
    # Never tried again by itself.
    clock.now += CONFIG.stuck_after * 10
    assert tip_id not in await service(db_session, payments, stripe, clock).due(10_000)


async def test_an_abandoned_refund_holds_nothing(
    db_session: AsyncSession,
    world: JobWorld,
    payments: FakeStripePayments,
    stripe: FakeStripeTransfers,
    clock: Clock,
) -> None:
    tip_id, job_id, _ = await committed_tip(db_session, world, payments)
    await add_refund(db_session, job_id, RefundStatus.ABANDONED)

    assert tip_id in await service(db_session, payments, stripe, clock).due(10_000)
    assert await service(db_session, payments, stripe, clock).release(tip_id) is (
        TipTransferOutcome.CREATED
    )


# --- The pro ----------------------------------------------------------------------------------


@pytest.mark.parametrize("why", [PRO_NOT_APPROVED, PAYOUTS_NOT_ENABLED])
async def test_the_tip_waits_for_its_pro_and_the_sweep_sends_it_once_they_can(
    db_session: AsyncSession,
    world: JobWorld,
    payments: FakeStripePayments,
    stripe: FakeStripeTransfers,
    clock: Clock,
    why: str,
) -> None:
    tip_id, _, _ = await committed_tip(db_session, world, payments)
    blocked = (
        {"verification_status": ProVerificationStatus.REJECTED}
        if why == PRO_NOT_APPROVED
        else {"payouts_enabled": False}
    )
    restored = (
        {"verification_status": ProVerificationStatus.APPROVED}
        if why == PRO_NOT_APPROVED
        else {"payouts_enabled": True}
    )
    profile = update(ProProfile).where(ProProfile.id == world.pro.profile_id)
    await db_session.execute(profile.values(**blocked))
    await db_session.commit()

    assert await service(db_session, payments, stripe, clock).release(tip_id) is (
        TipTransferOutcome.HELD
    )
    row = await tip_row(db_session, tip_id)
    assert (row.transfer_status, row.transfer_last_error_code) == (TipTransferStatus.HELD, why)
    assert (stripe.creates, payments.tip_charge_reads) == ([], [])
    assert tip_id not in await service(db_session, payments, stripe, clock).due(10_000)

    await db_session.execute(profile.values(**restored))
    await db_session.commit()

    assert tip_id in await service(db_session, payments, stripe, clock).due(10_000)
    assert await service(db_session, payments, stripe, clock).release(tip_id) is (
        TipTransferOutcome.CREATED
    )
    assert len(stripe.creates) == 1


# --- What Stripe holds of the tip, read before anything is sent --------------------------------


@pytest.mark.parametrize(
    ("change", "reason"),
    [
        ({"job_id": str(uuid.uuid4())}, "tip_intent_mismatch"),
        ({"tip_id": str(uuid.uuid4())}, "tip_intent_mismatch"),
        ({"customer_id": "cus_someoneelse"}, "tip_intent_mismatch"),
        ({"amount_cents": TIP - 1}, "tip_intent_mismatch"),
        ({"currency": "eur"}, "tip_intent_mismatch"),
        ({"kind": None}, "tip_intent_mismatch"),
        ({"attempt": "2"}, "tip_intent_mismatch"),
        ({"status": "processing"}, "tip_not_charged"),
        ("no_charge", "tip_not_charged"),
        ("refunded", "tip_charge_returned"),
        ("disputed", "tip_charge_returned"),
    ],
)
async def test_a_tip_charge_stripe_does_not_show_as_this_tips_and_paid_is_never_sent(
    db_session: AsyncSession,
    world: JobWorld,
    payments: FakeStripePayments,
    stripe: FakeStripeTransfers,
    clock: Clock,
    caplog: pytest.LogCaptureFixture,
    change: dict[str, object] | str,
    reason: str,
) -> None:
    tip_id, _, _ = await committed_tip(db_session, world, payments)
    [intent] = payments.tip_facts
    if change == "no_charge":
        payments.tip_charges[intent] = None
    elif change == "refunded":
        payments.refunded_charges.add(intent)
    elif change == "disputed":
        payments.disputed_charges.add(intent)
    elif isinstance(change, dict):
        status = change.pop("status", None)
        if status is not None:
            payments.tip_statuses[intent] = str(status)
        payments.tip_facts[intent] = TipIntentFacts(
            **{**payments.tip_facts[intent].__dict__, **change}
        )

    outcome = await service(db_session, payments, stripe, clock).release(tip_id)

    assert outcome is TipTransferOutcome.NEEDS_REVIEW
    row = await tip_row(db_session, tip_id)
    assert (row.transfer_status, row.transfer_last_error_code) == (
        TipTransferStatus.HELD,
        TIP_CHARGE_NOT_PAYABLE,
    )
    assert (stripe.creates, stripe.lists) == ([], [])
    [record] = [r for r in caplog.records if r.message == "tip_transfer_needs_review"]
    assert record.__dict__["reason"] == reason


async def test_a_failed_read_of_the_tip_is_tried_again(
    db_session: AsyncSession,
    world: JobWorld,
    payments: FakeStripePayments,
    stripe: FakeStripeTransfers,
    clock: Clock,
) -> None:
    tip_id, _, _ = await committed_tip(db_session, world, payments)
    payments.errors["tip_charge"] = StripeUnavailableError(request_id="req_down")

    assert await service(db_session, payments, stripe, clock).release(tip_id) is (
        TipTransferOutcome.FAILED
    )
    del payments.errors["tip_charge"]
    row = await tip_row(db_session, tip_id)
    assert (row.transfer_status, row.transfer_last_error_code) == (
        TipTransferStatus.FAILED,
        "StripeUnavailableError",
    )
    assert stripe.creates == []
    assert tip_id not in await service(db_session, payments, stripe, clock).due(10_000)
    clock.now += CONFIG.stuck_after

    assert tip_id in await service(db_session, payments, stripe, clock).due(10_000)
    assert await service(db_session, payments, stripe, clock).release(tip_id) is (
        TipTransferOutcome.CREATED
    )


# --- Retries: a lost answer, a refusal --------------------------------------------------------


async def test_a_lost_answer_is_found_again_and_never_sent_twice(
    db_session: AsyncSession,
    world: JobWorld,
    payments: FakeStripePayments,
    stripe: FakeStripeTransfers,
    clock: Clock,
) -> None:
    tip_id, _, request_id = await committed_tip(db_session, world, payments)
    stripe.lost_answers = 1

    first = await service(db_session, payments, stripe, clock).release(tip_id)
    clock.now += CONFIG.stuck_after
    second = await service(db_session, payments, stripe, clock).release(tip_id)

    assert (first, second) == (TipTransferOutcome.FAILED, TipTransferOutcome.CREATED)
    assert len(stripe.creates) == 1
    assert stripe.lists == [transfer_group(request_id)]
    row = await tip_row(db_session, tip_id)
    [made] = stripe.by_key.values()
    assert (row.stripe_transfer_id, row.transfer_attempts) == (made, 2)


@pytest.mark.parametrize("code", sorted(tip_transfers.TIP_TRANSFER_REFUSED_CODES))
async def test_a_create_stripe_refuses_for_good_is_staffs(
    db_session: AsyncSession,
    world: JobWorld,
    payments: FakeStripePayments,
    stripe: FakeStripeTransfers,
    clock: Clock,
    code: str,
) -> None:
    tip_id, _, _ = await committed_tip(db_session, world, payments)
    stripe.errors["create"] = [StripeRejectedError(request_id="req_no", code=code)]

    outcome = await service(db_session, payments, stripe, clock).release(tip_id)

    assert outcome is TipTransferOutcome.NEEDS_REVIEW
    row = await tip_row(db_session, tip_id)
    assert (row.transfer_status, row.transfer_last_error_code) == (
        TipTransferStatus.HELD,
        TIP_TRANSFER_REFUSED,
    )
    clock.now += CONFIG.stuck_after * 10
    assert tip_id not in await service(db_session, payments, stripe, clock).due(10_000)


@pytest.mark.parametrize("code", ["parameter_invalid_integer", "api_key_expired", None])
async def test_any_other_refusal_is_tried_again_and_looked_up_first(
    db_session: AsyncSession,
    world: JobWorld,
    payments: FakeStripePayments,
    stripe: FakeStripeTransfers,
    clock: Clock,
    code: str | None,
) -> None:
    tip_id, _, _ = await committed_tip(db_session, world, payments)
    stripe.errors["create"] = [StripeRejectedError(request_id="req_no", code=code)]

    outcome = await service(db_session, payments, stripe, clock).release(tip_id)

    assert outcome is TipTransferOutcome.FAILED
    row = await tip_row(db_session, tip_id)
    assert row.transfer_status is TipTransferStatus.FAILED
    assert row.transfer_last_error_code == (code or "StripeRejectedError")
    clock.now += CONFIG.stuck_after
    assert tip_id in await service(db_session, payments, stripe, clock).due(10_000)
    assert await service(db_session, payments, stripe, clock).release(tip_id) is (
        TipTransferOutcome.CREATED
    )
    assert len(stripe.lists) == 1


@pytest.mark.parametrize("found", ["incomplete", "several", "reversed", "other_amount", "job_id"])
async def test_a_lookup_that_cannot_be_matched_creates_nothing(
    db_session: AsyncSession,
    world: JobWorld,
    payments: FakeStripePayments,
    stripe: FakeStripeTransfers,
    clock: Clock,
    found: str,
) -> None:
    tip_id, _, request_id = await committed_tip(db_session, world, payments)
    stripe.errors["create"] = [StripeUnavailableError(request_id="req_down")]
    await service(db_session, payments, stripe, clock).release(tip_id)
    clock.now += CONFIG.stuck_after
    ours = TransferFacts(
        transfer_id="tr_probe68found",
        amount_cents=TIP,
        currency="usd",
        destination=ACCOUNT,
        job_id=None,
        reversed=found == "reversed",
        request_id=None,
        kind="tip",
        tip_id=str(tip_id),
    )
    group = transfer_group(request_id)
    if found == "incomplete":
        stripe.list_complete = False
    elif found == "several":
        stripe.add(ours, group)
        stripe.add(TransferFacts(**{**ours.__dict__, "transfer_id": "tr_probe68two"}), group)
    elif found == "other_amount":
        stripe.add(TransferFacts(**{**ours.__dict__, "amount_cents": TIP - 100}), group)
    elif found == "job_id":
        stripe.add(TransferFacts(**{**ours.__dict__, "job_id": str(uuid.uuid4())}), group)
    else:
        stripe.add(ours, group)

    outcome = await service(db_session, payments, stripe, clock).release(tip_id)

    assert outcome is TipTransferOutcome.NEEDS_REVIEW
    assert stripe.creates == []
    row = await tip_row(db_session, tip_id)
    assert (row.transfer_status, row.transfer_last_error_code, row.stripe_transfer_id) == (
        TipTransferStatus.HELD,
        TIP_TRANSFER_NEEDS_REVIEW,
        None,
    )


async def test_an_attempt_under_way_is_left_alone_until_it_is_too_old(
    db_session: AsyncSession,
    world: JobWorld,
    payments: FakeStripePayments,
    stripe: FakeStripeTransfers,
    clock: Clock,
) -> None:
    tip_id, _, _ = await committed_tip(
        db_session,
        world,
        payments,
        transfer_status=TipTransferStatus.PENDING,
        transfer_attempts=1,
        transfer_requested_at=NOW - timedelta(minutes=1),
    )

    assert await service(db_session, payments, stripe, clock).release(tip_id) is (
        TipTransferOutcome.IN_FLIGHT
    )
    assert tip_id not in await service(db_session, payments, stripe, clock).due(10_000)
    clock.now += CONFIG.stuck_after

    assert tip_id in await service(db_session, payments, stripe, clock).due(10_000)
    assert await service(db_session, payments, stripe, clock).release(tip_id) is (
        TipTransferOutcome.CREATED
    )
    # A dead worker's attempt may have made it: the second attempt looks first.
    assert len(stripe.lists) == 1


# --- The boundary: a dispute or refund committed while Stripe was read -----------------------


@pytest.mark.parametrize("late", ["dispute", "refund"])
async def test_a_hold_committed_while_stripe_was_read_stops_the_create(
    db_session: AsyncSession,
    world: JobWorld,
    payments: FakeStripePayments,
    stripe: FakeStripeTransfers,
    clock: Clock,
    late: str,
) -> None:
    tip_id, job_id, _ = await committed_tip(db_session, world, payments)
    read = payments.tip_charge

    async def read_then_hold(payment_intent_id: str) -> Any:
        if late == "dispute":
            await add_dispute(db_session, world, job_id, DisputeStatus.OPEN)
        else:
            await add_refund(db_session, job_id, RefundStatus.PENDING)
        return await read(payment_intent_id)

    payments.tip_charge = read_then_hold  # type: ignore[method-assign]  # a hook inside the read

    outcome = await service(db_session, payments, stripe, clock).release(tip_id)

    assert outcome is TipTransferOutcome.NEEDS_REVIEW
    assert stripe.creates == []
    row = await tip_row(db_session, tip_id)
    assert (row.transfer_status, row.transfer_last_error_code) == (
        TipTransferStatus.HELD,
        JOB_REFUNDED_OR_DISPUTED,
    )


async def test_a_hold_found_as_the_transfer_is_stored_is_flagged_never_undone(
    db_session: AsyncSession,
    world: JobWorld,
    payments: FakeStripePayments,
    stripe: FakeStripeTransfers,
    clock: Clock,
    caplog: pytest.LogCaptureFixture,
) -> None:
    tip_id, job_id, _ = await committed_tip(db_session, world, payments)

    async def hold_during_create() -> None:
        await add_dispute(db_session, world, job_id, DisputeStatus.OPEN)

    stripe.on_create = hold_during_create

    outcome = await service(db_session, payments, stripe, clock).release(tip_id)

    assert outcome is TipTransferOutcome.CREATED
    assert (await tip_row(db_session, tip_id)).transfer_status is TipTransferStatus.CREATED
    assert [r.levelno for r in caplog.records if r.message == "tip_transfer_needs_reversal"] == [
        logging.ERROR
    ]


# --- Reversals ------------------------------------------------------------------------------


async def test_a_reversal_found_by_the_read_after_the_create_is_recorded(
    db_session: AsyncSession,
    world: JobWorld,
    payments: FakeStripePayments,
    stripe: FakeStripeTransfers,
    clock: Clock,
    caplog: pytest.LogCaptureFixture,
) -> None:
    tip_id, _, _ = await committed_tip(db_session, world, payments)
    original = stripe.retrieve_transfer

    async def reversed_read(transfer_id: str) -> TransferFacts:
        return TransferFacts(**{**(await original(transfer_id)).__dict__, "reversed": True})

    stripe.retrieve_transfer = reversed_read  # type: ignore[method-assign]  # Stripe reversed it

    assert await service(db_session, payments, stripe, clock).release(tip_id) is (
        TipTransferOutcome.CREATED
    )

    row = await tip_row(db_session, tip_id)
    assert row.transfer_status is TipTransferStatus.REVERSED
    assert row.transfer_reversal_checked_at is not None
    assert "tip_transfer_reversed" in messages(caplog)


async def test_a_failed_read_after_the_create_is_done_by_the_recovery_cron(
    db_session: AsyncSession,
    world: JobWorld,
    payments: FakeStripePayments,
    stripe: FakeStripeTransfers,
    clock: Clock,
) -> None:
    tip_id, _, _ = await committed_tip(db_session, world, payments)
    stripe.errors["retrieve"] = [StripeUnavailableError(request_id="req_down")]
    assert await service(db_session, payments, stripe, clock).release(tip_id) is (
        TipTransferOutcome.CREATED
    )
    assert (await tip_row(db_session, tip_id)).transfer_reversal_checked_at is None
    tips = service(db_session, payments, stripe, clock)
    assert tip_id not in await tips.unchecked_for_reversal(10_000)
    clock.now += CONFIG.stuck_after

    assert tip_id in await tips.unchecked_for_reversal(10_000)
    assert await tips.check_reversal(tip_id) is ReversalCheckOutcome.CHECKED
    assert await tips.check_reversal(tip_id) is ReversalCheckOutcome.SKIPPED

    assert (await tip_row(db_session, tip_id)).transfer_reversal_checked_at is not None
    assert len(stripe.creates) == 1


async def test_transfer_reversed_for_a_tip_transfer_reaches_the_tip_once(
    db_session: AsyncSession,
    world: JobWorld,
    payments: FakeStripePayments,
    stripe: FakeStripeTransfers,
    clock: Clock,
    caplog: pytest.LogCaptureFixture,
) -> None:
    tip_id, _, _ = await committed_tip(db_session, world, payments)
    await service(db_session, payments, stripe, clock).release(tip_id)
    [made] = stripe.by_key.values()
    handler = handler_for("transfer.reversed")
    assert handler is not None

    def tip_event(transfer_id: str) -> StripeEvent:
        event = reversed_event(transfer_id)
        event.payload["data"]["object"]["metadata"] = {"kind": "tip", "tip_id": str(tip_id)}  # type: ignore[index]  # the dict reversed_event built
        return event

    await handler(db_session, tip_event(made), AfterCommit())
    await handler(db_session, tip_event(made), AfterCommit())  # a repeat: nothing
    await handler(db_session, tip_event("tr_probe68unknown"), AfterCommit())

    assert (await tip_row(db_session, tip_id)).transfer_status is TipTransferStatus.REVERSED
    assert messages(caplog).count("tip_transfer_reversed") == 1
    assert messages(caplog).count("tip_transfer_reversed_unknown") == 2
    # Never through the job transfer's handler.
    assert "transfer_reversed_unknown" not in messages(caplog)


# --- The worker -----------------------------------------------------------------------------


async def test_the_task_and_the_sweeps_go_through_the_release(
    db_session: AsyncSession,
    world: JobWorld,
    payments: FakeStripePayments,
    stripe: FakeStripeTransfers,
    caplog: pytest.LogCaptureFixture,
) -> None:
    caplog.set_level(logging.INFO)
    first, _, _ = await committed_tip(db_session, world, payments)
    second, _, _ = await committed_tip(db_session, world, payments)
    ctx = worker_ctx(db_session, stripe)
    ctx["stripe_payments"] = payments
    ctx["settings"] = make_settings(transfer_stuck_pending_minutes=15)

    await release_tip_transfer(ctx, str(first))
    await release_succeeded_tips(ctx)
    await check_tip_transfer_reversals(ctx)

    assert {create["metadata"]["tip_id"] for create in stripe.creates} == {
        str(first),
        str(second),
    }
    assert len(stripe.creates) == 2
    [summary] = [r for r in caplog.records if r.message == "tip_transfers_released"]
    assert summary.__dict__["outcomes"] == {"created": 1}
    assert_no_leak(caplog)


async def test_one_tips_error_never_stops_the_sweep(
    db_session: AsyncSession,
    world: JobWorld,
    payments: FakeStripePayments,
    stripe: FakeStripeTransfers,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    caplog.set_level(logging.INFO)
    first, _, _ = await committed_tip(db_session, world, payments)
    second, _, _ = await committed_tip(db_session, world, payments)
    real = TipTransferService.release

    async def release_or_fail(self: TipTransferService, tip_id: uuid.UUID) -> TipTransferOutcome:
        if tip_id == first:
            raise RuntimeError("probe")
        return await real(self, tip_id)

    monkeypatch.setattr(TipTransferService, "release", release_or_fail)
    ctx = worker_ctx(db_session, stripe)
    ctx["stripe_payments"] = payments

    await release_succeeded_tips(ctx)

    assert [create["metadata"]["tip_id"] for create in stripe.creates] == [str(second)]
    [summary] = [r for r in caplog.records if r.message == "tip_transfers_released"]
    assert summary.__dict__["outcomes"] == {"errored": 1, "created": 1}
