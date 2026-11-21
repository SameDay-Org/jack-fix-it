"""ARQ worker. Start it with:

arq app.worker.WorkerSettings --custom-log-dict app.observability.WORKER_LOG_CONFIG
"""

import logging
from typing import Any

from arq import cron, func
from arq.connections import RedisSettings
from arq.typing import WorkerCoroutine
from arq.worker import Function

from app.config import get_settings
from app.db import create_engine, create_session_factory
from app.integrations.email import ResendEmailSender
from app.integrations.expo_push import ExpoPushSender
from app.integrations.mapbox import provider_from_settings
from app.integrations.storage import S3Storage, StorageNotConfiguredError
from app.integrations.stripe_payments import StripePaymentsClient
from app.integrations.stripe_transfers import StripeTransfersClient
from app.modules.addresses.tasks import geocode_address
from app.modules.chat.tasks import purge_chat_originals
from app.modules.dispatch.tasks import (
    dispatch_request,
    redispatch_for_pro,
    redispatch_stalled_requests,
)
from app.modules.disputes.tasks import dispute_photo_sanitize_task
from app.modules.jobs.tasks import auto_confirm_jobs, photo_sanitize_task
from app.modules.media.resweep import requeue_stale_media_copies
from app.modules.notifications.push_tasks import check_push_receipts, send_push
from app.modules.payments.cancel_refund_tasks import refund_cancellation, retry_cancel_refunds
from app.modules.payments.tasks import cancel_unpaid_payments
from app.modules.payments.transfer_tasks import (
    check_transfer_reversals,
    release_confirmed_jobs,
    release_transfer,
)
from app.modules.quotes.tasks import expire_quotes
from app.modules.receipts.tasks import send_payment_receipt, send_tip_receipt
from app.modules.requests.tasks import sanitize_task
from app.modules.tips.tasks import cancel_unpaid_tips
from app.modules.tips.transfer_tasks import (
    check_tip_transfer_reversals,
    release_succeeded_tips,
    release_tip_transfer,
)
from app.modules.uploads.tasks import sweep_orphan_uploads
from app.modules.webhooks.tasks import process_stripe_event
from app.observability import configure_logging, init_sentry

logger = logging.getLogger(__name__)


async def ping(ctx: dict[str, Any]) -> str:
    """Smoke-test task. ARQ refuses to start with zero functions."""
    return "pong"


async def startup(ctx: dict[str, Any]) -> None:
    settings = get_settings()
    configure_logging(settings.log_level)
    init_sentry(settings)
    # What the tasks use (dispatch.tasks, push_tasks.PushDeps.from_context); ARQ adds
    # ctx["redis"] itself.
    engine = create_engine(settings)
    ctx["settings"] = settings
    ctx["engine"] = engine
    ctx["session_factory"] = create_session_factory(engine)
    ctx["push_sender"] = ExpoPushSender.from_settings(settings)
    # The receipt emails (#62). Without RESEND_API_KEY and EMAIL_FROM (allowed outside staging
    # and production) none is sent: receipts.tasks logs it, and the receipt stays in the app.
    ctx["email_sender"] = (
        ResendEmailSender.from_settings(settings)
        if settings.resend_api_key is not None and settings.email_from is not None
        else None
    )
    try:
        ctx["storage"] = S3Storage.from_settings(settings)
    except StorageNotConfiguredError:
        # Development without storage: media copies wait (sanitize_request_media logs it), and
        # the orphan upload sweep has nothing to sweep.
        ctx["storage"] = None
    # Without STRIPE_SECRET_KEY (allowed outside staging and production) the unpaid payment
    # sweep cancels no PaymentIntent in Stripe (cancel_unpaid_payments logs it).
    ctx["stripe_payments"] = (
        None if settings.stripe_secret_key is None else StripePaymentsClient.from_settings(settings)
    )
    # Geocode on save (#384). Without MAPBOX_ACCESS_TOKEN it is the stand-in whose every
    # call is unavailable: geocode_address then keeps nothing, and logs it.
    ctx["address_geocoder"] = provider_from_settings(settings)
    # The same key makes the transfers to the pros (#68): without it no job is released
    # (release_transfer and release_confirmed_jobs log it), and no reversal is read again.
    ctx["stripe_transfers"] = (
        None
        if settings.stripe_secret_key is None
        else StripeTransfersClient.from_settings(settings)
    )
    # Sentinel looks for this line to confirm a worker deploy is healthy.
    logger.info("worker_started", extra={"app_env": settings.app_env})


async def shutdown(ctx: dict[str, Any]) -> None:
    if "engine" in ctx:
        await ctx["engine"].dispose()
    logger.info("worker_stopped")


def discarding_result(
    coroutine: WorkerCoroutine,
    *,
    max_tries: int | None = None,
    timeout: float | None = None,
) -> Function:
    """A worker function that keeps no result in Redis (#176). A failed job's result is its
    pickled exception, and a database error's text holds its SQL statement with literals.
    Register every function through it (tests/test_worker.py checks)."""
    return func(
        coroutine, keep_result=0, keep_result_forever=False, max_tries=max_tries, timeout=timeout
    )


def every(minutes: int) -> set[int]:
    """The minutes of the hour a cron every `minutes` runs at (60 means once an hour)."""
    return set(range(0, 60, minutes))


class WorkerSettings:
    functions = (
        discarding_result(ping),
        discarding_result(dispatch_request),
        # One run per kick (#478): the re-dispatch sweep below is its retry.
        discarding_result(redispatch_for_pro, max_tries=1),
        # With no result kept, a receipt that asks for a resend can queue the message's job id
        # again once the first run is over; the tries match the sends per device.
        discarding_result(send_push, max_tries=get_settings().push_max_attempts),
        sanitize_task(get_settings()),
        photo_sanitize_task(get_settings()),
        dispute_photo_sanitize_task(get_settings()),
        # A run per handler attempt: a failing event is failed on its last one.
        discarding_result(
            process_stripe_event, max_tries=get_settings().stripe_webhook_max_attempts
        ),
        # One try: each run that reaches Mapbox is a billed call, and a geocode that did not
        # happen costs nothing but the route's own geocoding (#384).
        discarding_result(geocode_address, max_tries=1),
        # One run per queued confirmation; it never raises, and the sweep below takes whatever
        # a run could not finish.
        discarding_result(release_transfer, max_tries=1),
        # A tip's transfer (#273 PR A2): one try, as the job's; its sweep is the retry.
        discarding_result(release_tip_transfer, max_tries=1),
        # One run per cancel (#69); it never raises, and the sweep below makes whatever a run
        # could not.
        discarding_result(refund_cancellation, max_tries=1),
        # One run per payment or tip (#62), tried again by ARQ while Resend or Stripe is
        # unavailable (receipts.tasks raises Retry until its last try).
        discarding_result(
            send_payment_receipt, max_tries=get_settings().receipt_email_max_attempts
        ),
        discarding_result(send_tip_receipt, max_tries=get_settings().receipt_email_max_attempts),
    )
    # A cron job keeps no result by default (ARQ's cron keep_result is 0); stated anyway.
    cron_jobs = (
        cron(
            check_push_receipts,
            minute=every(get_settings().push_receipt_check_minutes),
            keep_result=0,
            keep_result_forever=False,
        ),
        # Safe copies an outage (or a missed queue) left pending (#473).
        cron(
            requeue_stale_media_copies,
            minute=every(get_settings().media_sanitize_resweep_minutes),
            timeout=get_settings().media_sanitize_resweep_timeout_seconds,
            keep_result=0,
            keep_result_forever=False,
        ),
        cron(
            sweep_orphan_uploads,
            minute=every(get_settings().orphan_upload_sweep_minutes),
            timeout=get_settings().orphan_upload_sweep_timeout_seconds,
            keep_result=0,
            keep_result_forever=False,
        ),
        cron(
            redispatch_stalled_requests,
            minute=every(get_settings().redispatch_sweep_minutes),
            timeout=get_settings().redispatch_sweep_timeout_seconds,
            keep_result=0,
            keep_result_forever=False,
        ),
        cron(
            expire_quotes,
            minute=every(get_settings().quote_expiry_sweep_minutes),
            timeout=get_settings().quote_expiry_timeout_seconds,
            keep_result=0,
            keep_result_forever=False,
        ),
        cron(
            purge_chat_originals,
            minute=every(get_settings().chat_original_purge_minutes),
            timeout=get_settings().chat_original_purge_timeout_seconds,
            keep_result=0,
            keep_result_forever=False,
        ),
        cron(
            cancel_unpaid_payments,
            minute=every(get_settings().payment_unpaid_sweep_minutes),
            timeout=get_settings().payment_unpaid_sweep_timeout_seconds,
            keep_result=0,
            keep_result_forever=False,
        ),
        # Tips left unpaid (#273), on the unpaid payments' window, cadence and timeout.
        cron(
            cancel_unpaid_tips,
            minute=every(get_settings().payment_unpaid_sweep_minutes),
            timeout=get_settings().payment_unpaid_sweep_timeout_seconds,
            keep_result=0,
            keep_result_forever=False,
        ),
        cron(
            auto_confirm_jobs,
            minute=every(get_settings().job_auto_confirm_sweep_minutes),
            timeout=get_settings().job_auto_confirm_sweep_timeout_seconds,
            keep_result=0,
            keep_result_forever=False,
        ),
        cron(
            release_confirmed_jobs,
            minute=every(get_settings().transfer_release_sweep_minutes),
            timeout=get_settings().transfer_release_sweep_timeout_seconds,
            keep_result=0,
            keep_result_forever=False,
        ),
        # Cancelled jobs' refunds left without Stripe's answer (#69).
        cron(
            retry_cancel_refunds,
            minute=every(get_settings().cancel_refund_sweep_minutes),
            timeout=get_settings().cancel_refund_sweep_timeout_seconds,
            keep_result=0,
            keep_result_forever=False,
        ),
        # The recovery of the transfers' reversal checks (#416 r2), on the release sweep's
        # cadence and timeout: read-only Stripe calls, never a create.
        cron(
            check_transfer_reversals,
            minute=every(get_settings().transfer_release_sweep_minutes),
            timeout=get_settings().transfer_release_sweep_timeout_seconds,
            keep_result=0,
            keep_result_forever=False,
        ),
        # The tips' transfers (#273 PR A2), on the job transfers' cadence, timeout and batch:
        # the net under the release queued when a tip succeeds, and the recovery of the read
        # after each create.
        cron(
            release_succeeded_tips,
            minute=every(get_settings().transfer_release_sweep_minutes),
            timeout=get_settings().transfer_release_sweep_timeout_seconds,
            keep_result=0,
            keep_result_forever=False,
        ),
        cron(
            check_tip_transfer_reversals,
            minute=every(get_settings().transfer_release_sweep_minutes),
            timeout=get_settings().transfer_release_sweep_timeout_seconds,
            keep_result=0,
            keep_result_forever=False,
        ),
    )
    # The worker's own default, which also covers the results ARQ writes itself for a job that
    # fails before it runs (too many tries, an unknown function): none is kept (#176).
    keep_result = 0
    keep_result_forever = False
    on_startup = startup
    on_shutdown = shutdown
    redis_settings = RedisSettings.from_dsn(get_settings().redis_url)
