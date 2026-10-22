"""Worker side of push notifications (D10.3, #54): send_push and the receipts cron.

Both are idempotent and bounded. send_push claims its message id in Redis before sending, so a
second run of the same message does nothing; a failed send releases the claim and asks ARQ to
retry later (Retry with a growing delay), never in a loop. Expo's verdicts clean up devices:
DeviceNotRegistered, right away on the ticket or later on the receipt, deletes the device.
Every Redis and HTTP call has a timeout. Logs carry user and device ids and counts only.
"""

import asyncio
import logging
import uuid
from collections.abc import AsyncIterator, Callable, Mapping
from contextlib import AbstractAsyncContextManager
from dataclasses import dataclass
from typing import Any, Final

from arq import Retry
from redis.asyncio import Redis
from redis.exceptions import RedisError
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings
from app.integrations.expo_push import (
    DEVICE_NOT_REGISTERED,
    RECEIPTS_BATCH,
    PushMessage,
    PushSender,
    PushUnavailableError,
)
from app.modules.devices.service import DeviceService, PushTarget
from app.modules.notifications import catalog
from app.modules.notifications.service import PushRequest
from app.modules.users.service import UserService

logger = logging.getLogger(__name__)

KEY_PREFIX: Final = "push"

SessionFactory = Callable[[], AbstractAsyncContextManager[AsyncSession]]


class PushStore:
    """Redis keys of push delivery: `<prefix>:message:<id>` (sent once) and
    `<prefix>:ticket:<ticket id>` -> device id (waiting for its receipt)."""

    def __init__(
        self, redis: Redis, *, ttl_seconds: int, timeout_seconds: float, prefix: str = KEY_PREFIX
    ) -> None:
        self._redis = redis
        self._ttl = ttl_seconds
        self._timeout = timeout_seconds
        self._prefix = prefix

    async def claim_message(self, message_id: str) -> bool:
        async with asyncio.timeout(self._timeout):
            claimed = await self._redis.set(
                f"{self._prefix}:message:{message_id}", 1, nx=True, ex=self._ttl
            )
        return bool(claimed)

    async def release_message(self, message_id: str) -> None:
        async with asyncio.timeout(self._timeout):
            await self._redis.delete(f"{self._prefix}:message:{message_id}")

    async def remember_tickets(self, tickets: Mapping[str, uuid.UUID]) -> None:
        if not tickets:
            return
        async with asyncio.timeout(self._timeout), self._redis.pipeline() as pipe:
            for ticket_id, device_id in tickets.items():
                pipe.set(f"{self._prefix}:ticket:{ticket_id}", str(device_id), ex=self._ttl)
            await pipe.execute()

    async def pending_batches(self, size: int) -> AsyncIterator[dict[str, uuid.UUID]]:
        """Tickets waiting for a receipt, `size` at a time: {ticket id: device id}."""
        prefix = f"{self._prefix}:ticket:"
        batch: dict[str, uuid.UUID] = {}
        async with asyncio.timeout(self._timeout):
            keys = [key async for key in self._redis.scan_iter(match=f"{prefix}*", count=size)]
        for start in range(0, len(keys), size):
            chunk = keys[start : start + size]
            async with asyncio.timeout(self._timeout):
                values = await self._redis.mget(chunk)
            batch = {
                _text(key).removeprefix(prefix): uuid.UUID(_text(value))
                for key, value in zip(chunk, values, strict=True)
                if value is not None  # expired between the scan and the read
            }
            if batch:
                yield batch

    async def forget_tickets(self, ticket_ids: list[str]) -> None:
        if not ticket_ids:
            return
        async with asyncio.timeout(self._timeout):
            await self._redis.delete(*(f"{self._prefix}:ticket:{t}" for t in ticket_ids))


def _text(value: bytes | str) -> str:
    return value.decode() if isinstance(value, bytes) else value


@dataclass(frozen=True)
class PushDeps:
    sessions: SessionFactory
    sender: PushSender
    store: PushStore
    max_devices_per_user: int
    retry_backoff_seconds: int

    @classmethod
    def from_context(cls, ctx: Mapping[str, Any]) -> "PushDeps":
        """What the worker's startup put in ARQ's context (see app.worker)."""
        settings: Settings = ctx["settings"]
        return cls(
            sessions=ctx["session_factory"],
            sender=ctx["push_sender"],
            store=PushStore(
                ctx["redis"],
                ttl_seconds=settings.push_ticket_ttl_seconds,
                timeout_seconds=settings.push_send_timeout_seconds,
                # Tests keep their keys apart; the worker uses the default.
                prefix=ctx.get("push_key_prefix", KEY_PREFIX),
            ),
            max_devices_per_user=settings.push_max_devices_per_user,
            retry_backoff_seconds=settings.push_retry_backoff_seconds,
        )


async def send_push(
    ctx: dict[str, Any],
    user_id: str,
    message_id: str,
    title_key: str,
    body_key: str,
    params: dict[str, str],
    deep_link: str,
) -> None:
    """ARQ task: sends one message to every device of the user, once."""
    deps = PushDeps.from_context(ctx)
    request = PushRequest(uuid.UUID(user_id), message_id, title_key, body_key, params, deep_link)
    request.validate()  # what enqueue_push checked, again: the queue is not trusted
    extra = {"user_id": user_id}
    try:
        claimed = await deps.store.claim_message(message_id)
    except (RedisError, OSError):
        raise _retry(ctx, deps, extra) from None
    if not claimed:
        logger.info("push_already_sent", extra=extra)
        return
    try:
        targets, locale = await _targets_and_locale(deps, request.user_id)
        if not targets:
            logger.info("push_no_devices", extra=extra)
            return
        messages = [
            PushMessage(
                to=target.expo_push_token,
                title=catalog.render(locale, title_key, params),
                body=catalog.render(locale, body_key, params),
                data={"url": deep_link},
            )
            for target in targets
        ]
        tickets = await deps.sender.send(messages)
    except (PushUnavailableError, RedisError, OSError, SQLAlchemyError):
        try:
            await deps.store.release_message(message_id)
        except (RedisError, OSError):
            # The claim expires with the ticket TTL; until then a retry would skip this push.
            logger.error("push_claim_not_released", extra=extra)
        raise _retry(ctx, deps, extra) from None

    sent: dict[str, uuid.UUID] = {}
    dead: list[uuid.UUID] = []
    for target, ticket in zip(targets, tickets, strict=True):
        if ticket.id is not None:
            sent[ticket.id] = target.device_id
        elif ticket.error == DEVICE_NOT_REGISTERED:
            dead.append(target.device_id)
    await _forget_devices(deps, dead)
    try:
        await deps.store.remember_tickets(sent)
    except (RedisError, OSError):
        # Sent already: retrying would push twice. Only the receipt check is lost.
        logger.error("push_tickets_not_stored", extra={**extra, "count": len(sent)})
    logger.info(
        "push_sent",
        extra={**extra, "sent": len(sent), "dead": len(dead), "failed": len(tickets) - len(sent)},
    )


def _retry(ctx: Mapping[str, Any], deps: PushDeps, extra: dict[str, str]) -> Retry:
    """ARQ runs the job again later, each attempt waiting longer; never a tight loop."""
    attempt = int(ctx.get("job_try", 1))
    logger.warning("push_send_retry", extra={**extra, "attempt": attempt})
    return Retry(defer=deps.retry_backoff_seconds * attempt)


async def check_push_receipts(ctx: dict[str, Any]) -> None:
    """ARQ cron: asks Expo for the receipts of stored tickets. A receipt (ok or not) ends a
    ticket; DeviceNotRegistered also deletes its device. Pending ones wait for the next run."""
    deps = PushDeps.from_context(ctx)
    checked = dead = 0
    try:
        async for batch in deps.store.pending_batches(RECEIPTS_BATCH):
            receipts = await deps.sender.get_receipts(list(batch))
            gone = [
                batch[ticket_id]
                for ticket_id, receipt in receipts.items()
                if receipt.error == DEVICE_NOT_REGISTERED and ticket_id in batch
            ]
            await _forget_devices(deps, gone)
            await deps.store.forget_tickets([t for t in receipts if t in batch])
            checked += len(receipts)
            dead += len(gone)
    except (PushUnavailableError, RedisError, OSError):
        # The next run tries again; nothing is lost while the tickets live.
        logger.warning("push_receipts_unavailable", extra={"checked": checked})
        return
    logger.info("push_receipts_checked", extra={"checked": checked, "dead": dead})


async def _targets_and_locale(deps: PushDeps, user_id: uuid.UUID) -> tuple[list[PushTarget], str]:
    # The session closes before Expo is called: no connection waits on the network.
    async with deps.sessions() as session:
        user = await UserService(session).get_by_id(user_id)
        if user is None:
            return [], catalog.DEFAULT_LOCALE
        targets = await DeviceService(session, deps.max_devices_per_user).targets_for(user_id)
        return targets, user.locale


async def _forget_devices(deps: PushDeps, device_ids: list[uuid.UUID]) -> None:
    if not device_ids:
        return
    async with deps.sessions() as session:
        devices = DeviceService(session, deps.max_devices_per_user)
        for device_id in device_ids:
            await devices.forget(device_id)
