"""Worker side of push notifications (D10.3, #54): send_push and the receipts cron.

Redis keeps each message's delivery state per device (Recipient), so every run of a message
sends only to the devices still pending: a device Expo accepted never gets the message again.
A retryable error (a batch Expo did not take, or MessageRateExceeded on a ticket or a receipt)
puts the device back to pending and the message runs again later, each time waiting longer,
until the device has had PUSH_MAX_ATTEMPTS sends; then it counts as failed. ARQ runs one job
per message id at a time (job id `push:<message id>`), so two runs of a message never overlap.
Expo's verdicts clean up devices: DeviceNotRegistered, on the ticket or later on the receipt,
deletes the device. A send's outcome is stored before that cleanup, and a cleanup that fails is
retried on its own, without sending. Every Redis and HTTP call has a timeout. Logs carry user
and device ids, Expo error codes and counts only.

Expo has no idempotency key, so a device is never left plain pending once it may have been sent
to: before the HTTP call its state becomes `in_flight` (if that write fails, nothing is sent and
the job retries), and after the call the outcome replaces it. If the outcome cannot be stored,
even after a few tries, the device stays `in_flight` and the next run marks it `unknown`, final:
it is never sent again. A push lost in that rare window is the price of never sending one twice
there (at most once).

That at-most-once guarantee covers only this recovery of a persisted `in_flight` state. An
HTTP call whose outcome is uncertain (a timeout, a connection error or a 5xx from Expo, with no
ticket back for a device) puts the device back to pending and retries it, as a retryable
error: if Expo had in fact accepted it, the device can get the push twice.
"""

import asyncio
import contextlib
import json
import logging
import uuid
from collections.abc import AsyncIterator, Awaitable, Callable, Mapping, Sequence
from contextlib import AbstractAsyncContextManager
from dataclasses import dataclass, replace
from enum import StrEnum
from typing import Any, Final, cast

from arq import Retry
from redis.asyncio import Redis
from redis.exceptions import RedisError
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings
from app.integrations.expo_push import (
    DEVICE_NOT_REGISTERED,
    RECEIPTS_BATCH,
    RETRYABLE_ERRORS,
    PushMessage,
    PushSender,
    PushUnavailableError,
    Ticket,
)
from app.modules.devices.service import DeviceService, PushTarget
from app.modules.notifications import catalog
from app.modules.notifications.service import (
    InvalidPushError,
    JobQueue,
    PushRequest,
    enqueue_push,
)
from app.modules.users.service import UserService

logger = logging.getLogger(__name__)

KEY_PREFIX: Final = "push"
# Writes of a send's outcome before giving up on it; each one is bounded by the store timeout.
OUTCOME_WRITE_TRIES: Final = 3
REQUEST_FIELD: Final = "request"

SessionFactory = Callable[[], AbstractAsyncContextManager[AsyncSession]]

# Sets a device's state only while it is still the one the caller read.
_SWAP_SCRIPT: Final = """
if redis.call('HGET', KEYS[1], ARGV[1]) == ARGV[2] then
  redis.call('HSET', KEYS[1], ARGV[1], ARGV[3])
  return 1
end
return 0
"""


class Status(StrEnum):
    PENDING = "pending"  # to send: never sent yet, or after a retryable error
    ACCEPTED = "accepted"  # Expo took it; its ticket waits for a receipt
    DEAD = "dead"  # DeviceNotRegistered; the device is still to be deleted
    GONE = "gone"  # DeviceNotRegistered; the device was deleted
    FAILED = "failed"  # a final error, or out of attempts
    IN_FLIGHT = "in_flight"  # handed to Expo; the outcome is not stored yet
    UNKNOWN = "unknown"  # its outcome was lost after the send: final, never sent again


class PushStateNotStoredError(RuntimeError):
    """A send's outcome could not be stored on the job's last try. The devices stay in_flight,
    so no later run sends to them again."""


@dataclass(frozen=True)
class Recipient:
    """One device's delivery of one message."""

    status: Status
    attempts: int = 0  # sends to this device so far
    ticket_id: str | None = None

    def encode(self) -> str:
        return f"{self.status}:{self.attempts}:{self.ticket_id or ''}"

    @classmethod
    def decode(cls, raw: bytes | str) -> "Recipient":
        status, attempts, ticket_id = _text(raw).split(":", 2)
        return cls(Status(status), int(attempts), ticket_id or None)


@dataclass(frozen=True)
class TicketRef:
    """What a ticket waiting for its receipt belongs to."""

    message_id: str
    device_id: uuid.UUID


class PushStore:
    """Redis keys of push delivery, each living PUSH_TICKET_TTL_SECONDS:
    `<prefix>:message:<id>`: a hash of the message's request (field `request`) and, per device
    id, its Recipient; `<prefix>:ticket:<ticket id>`: "<device id> <message id>", waiting for
    its receipt."""

    def __init__(
        self, redis: Redis, *, ttl_seconds: int, timeout_seconds: float, prefix: str = KEY_PREFIX
    ) -> None:
        self._redis = redis
        self._ttl = ttl_seconds
        self._timeout = timeout_seconds
        self._prefix = prefix
        self._swap = redis.register_script(_SWAP_SCRIPT)

    def _message_key(self, message_id: str) -> str:
        return f"{self._prefix}:message:{message_id}"

    async def delivery(self, message_id: str) -> dict[uuid.UUID, Recipient] | None:
        """The message's recipients; None before its first run."""
        async with asyncio.timeout(self._timeout):
            # redis-py types hash reads for its sync and async clients at once.
            fields = await cast(
                Awaitable[dict[bytes, bytes]], self._redis.hgetall(self._message_key(message_id))
            )
        if not fields:
            return None
        return {
            uuid.UUID(_text(name)): Recipient.decode(value)
            for name, value in fields.items()
            if _text(name) != REQUEST_FIELD
        }

    async def start(
        self, request: PushRequest, device_ids: Sequence[uuid.UUID]
    ) -> dict[uuid.UUID, Recipient]:
        """Fixes who gets the message: the user's devices at its first run, all pending."""
        recipients = {device_id: Recipient(Status.PENDING) for device_id in device_ids}
        stored = json.dumps(
            {
                "user_id": str(request.user_id),
                "title_key": request.title_key,
                "body_key": request.body_key,
                "params": dict(request.params),
                "deep_link": request.deep_link,
            }
        )
        key = self._message_key(request.message_id)
        async with asyncio.timeout(self._timeout), self._redis.pipeline(transaction=True) as pipe:
            pipe.hset(
                key,
                mapping={
                    REQUEST_FIELD: stored,
                    **{str(d): r.encode() for d, r in recipients.items()},
                },
            )
            pipe.expire(key, self._ttl)
            await pipe.execute()
        return recipients

    async def request(self, message_id: str) -> PushRequest | None:
        async with asyncio.timeout(self._timeout):
            raw = await cast(  # as in delivery
                Awaitable[bytes | None],
                self._redis.hget(self._message_key(message_id), REQUEST_FIELD),
            )
        if raw is None:
            return None
        values = json.loads(_text(raw))
        return PushRequest(
            uuid.UUID(values["user_id"]),
            message_id,
            values["title_key"],
            values["body_key"],
            values["params"],
            values["deep_link"],
        )

    async def record(self, message_id: str, recipients: Mapping[uuid.UUID, Recipient]) -> None:
        """Stores new states, and a ticket key per newly accepted device, in one transaction."""
        if not recipients:
            return
        key = self._message_key(message_id)
        async with asyncio.timeout(self._timeout), self._redis.pipeline(transaction=True) as pipe:
            pipe.hset(key, mapping={str(d): r.encode() for d, r in recipients.items()})
            pipe.expire(key, self._ttl, nx=True)  # only when the hash expired meanwhile
            for device_id, recipient in recipients.items():
                if recipient.status is Status.ACCEPTED and recipient.ticket_id is not None:
                    pipe.set(
                        f"{self._prefix}:ticket:{recipient.ticket_id}",
                        f"{device_id} {message_id}",
                        ex=self._ttl,
                    )
            await pipe.execute()

    async def swap(
        self, message_id: str, device_id: uuid.UUID, expected: Recipient, new: Recipient
    ) -> bool:
        """Sets one device's state only if it is still `expected`."""
        async with asyncio.timeout(self._timeout):
            swapped = await self._swap(
                keys=[self._message_key(message_id)],
                args=[str(device_id), expected.encode(), new.encode()],
            )
        return bool(swapped)

    async def pending_batches(self, size: int) -> AsyncIterator[dict[str, TicketRef]]:
        """Tickets waiting for a receipt, `size` at a time: {ticket id: what it belongs to}."""
        prefix = f"{self._prefix}:ticket:"
        async with asyncio.timeout(self._timeout):
            keys = [key async for key in self._redis.scan_iter(match=f"{prefix}*", count=size)]
        for start in range(0, len(keys), size):
            chunk = keys[start : start + size]
            async with asyncio.timeout(self._timeout):
                values = await self._redis.mget(chunk)
            batch: dict[str, TicketRef] = {}
            for key, value in zip(chunk, values, strict=True):
                if value is None:  # expired between the scan and the read
                    continue
                device_id, message_id = _text(value).split(" ", 1)
                batch[_text(key).removeprefix(prefix)] = TicketRef(message_id, uuid.UUID(device_id))
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
    queue: JobQueue
    max_devices_per_user: int
    max_attempts: int
    retry_backoff_seconds: int
    timeout_seconds: float

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
            # ARQ's own pool (an ArqRedis) queues the jobs; tests pass a fake queue.
            queue=ctx.get("push_queue", ctx["redis"]),
            max_devices_per_user=settings.push_max_devices_per_user,
            max_attempts=settings.push_max_attempts,
            retry_backoff_seconds=settings.push_retry_backoff_seconds,
            timeout_seconds=settings.push_send_timeout_seconds,
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
    """ARQ task: sends one message to every device the user had at its first run, once each."""
    deps = PushDeps.from_context(ctx)
    request = PushRequest(uuid.UUID(user_id), message_id, title_key, body_key, params, deep_link)
    request.validate()  # what enqueue_push checked, again: the queue is not trusted
    extra = {"user_id": user_id}
    attempt = int(ctx.get("job_try", 1))
    try:
        recipients = await deps.store.delivery(message_id)
        targets, locale = await _targets_and_locale(deps, request.user_id)
        if recipients is None:
            recipients = await deps.store.start(request, [t.device_id for t in targets])
        # In flight when an earlier run ended without storing the outcome: maybe delivered.
        lost = {
            device_id: replace(recipient, status=Status.UNKNOWN)
            for device_id, recipient in recipients.items()
            if recipient.status is Status.IN_FLIGHT
        }
        if lost:
            await deps.store.record(message_id, lost)
            logger.warning("push_outcome_unknown", extra={**extra, "count": len(lost)})
            recipients = {**recipients, **lost}
    except (RedisError, OSError, SQLAlchemyError):
        raise _retry(deps, attempt, extra) from None
    due = [t for t in targets if _status(recipients, t.device_id) is Status.PENDING]
    if not due and not any(r.status is Status.DEAD for r in recipients.values()):
        logger.info("push_already_sent" if recipients else "push_no_devices", extra=extra)
        return

    outcome: dict[uuid.UUID, Recipient] = {}
    if due:
        in_flight = {
            t.device_id: Recipient(Status.IN_FLIGHT, recipients[t.device_id].attempts + 1)
            for t in due
        }
        try:
            await deps.store.record(message_id, in_flight)
        except (RedisError, OSError):
            raise _retry(deps, attempt, extra) from None  # nothing was sent
        try:
            tickets = await deps.sender.send(
                [
                    PushMessage(
                        to=target.expo_push_token,
                        title=catalog.render(locale, title_key, params),
                        body=catalog.render(locale, body_key, params),
                        data={"url": deep_link},
                    )
                    for target in due
                ]
            )
        except PushUnavailableError as error:
            tickets = error.tickets  # the batches Expo took before the failure
        last_try = attempt >= deps.max_attempts
        for index, target in enumerate(due):
            ticket = tickets[index] if index < len(tickets) else None
            sends = in_flight[target.device_id].attempts
            outcome[target.device_id] = _after_send(
                ticket, sends, last_try or sends >= deps.max_attempts
            )
            if outcome[target.device_id].status is Status.FAILED:
                logger.warning(
                    "push_recipient_failed",
                    extra={
                        **extra,
                        "device_id": str(target.device_id),
                        "attempts": sends,
                        "error": ticket.error if ticket is not None else "unavailable",
                    },
                )
        if not await _store_outcome(deps, message_id, outcome):
            # The devices stay in_flight: the next run marks them unknown and never resends.
            logger.error("push_state_not_stored", extra={**extra, "count": len(outcome)})
            if attempt < deps.max_attempts:
                raise _retry(deps, attempt, extra)
            raise PushStateNotStoredError

    current = {**recipients, **outcome}
    cleaned = await _clean_up(
        deps, message_id, {d: r for d, r in current.items() if r.status is Status.DEAD}, extra
    )
    counts = {status.value: sum(r.status is status for r in outcome.values()) for status in Status}
    logger.info("push_sent", extra={**extra, **counts})
    if (not cleaned or counts[Status.PENDING] > 0) and attempt < deps.max_attempts:
        raise _retry(deps, attempt, extra)


async def _store_outcome(
    deps: PushDeps, message_id: str, outcome: Mapping[uuid.UUID, Recipient]
) -> bool:
    """Writes a send's outcome, trying again a few times; never sends again."""
    for _ in range(OUTCOME_WRITE_TRIES):
        try:
            await deps.store.record(message_id, outcome)
        except (RedisError, OSError):
            continue
        return True
    return False


def _status(recipients: Mapping[uuid.UUID, Recipient], device_id: uuid.UUID) -> Status | None:
    recipient = recipients.get(device_id)
    return recipient.status if recipient is not None else None


def _after_send(ticket: Ticket | None, sends: int, out_of_attempts: bool) -> Recipient:
    """A device's state after a send; `ticket` is None when Expo never answered for it."""
    if ticket is not None and ticket.id is not None:
        return Recipient(Status.ACCEPTED, sends, ticket.id)
    if ticket is not None and ticket.error == DEVICE_NOT_REGISTERED:
        return Recipient(Status.DEAD, sends)
    retryable = ticket is None or ticket.error in RETRYABLE_ERRORS
    if retryable and not out_of_attempts:
        return Recipient(Status.PENDING, sends)
    return Recipient(Status.FAILED, sends)


async def _clean_up(
    deps: PushDeps, message_id: str, dead: Mapping[uuid.UUID, Recipient], extra: dict[str, str]
) -> bool:
    """Deletes the devices Expo no longer knows. On a database failure they stay `dead` in the
    message's state and the next run of the message deletes them, without sending; False."""
    if not dead:
        return True
    try:
        await _forget_devices(deps, list(dead))
    except (SQLAlchemyError, OSError):
        logger.error("push_cleanup_failed", extra={**extra, "count": len(dead)})
        return False
    # If this fails they stay `dead`: a later run deletes them again, which changes nothing.
    with contextlib.suppress(RedisError, OSError):
        await deps.store.record(
            message_id, {d: replace(r, status=Status.GONE) for d, r in dead.items()}
        )
    return True


def _retry(deps: PushDeps, attempt: int, extra: dict[str, str]) -> Retry:
    """ARQ runs the job again later, each attempt waiting longer; never a tight loop."""
    logger.warning("push_send_retry", extra={**extra, "attempt": attempt})
    return Retry(defer=deps.retry_backoff_seconds * attempt)


async def check_push_receipts(ctx: dict[str, Any]) -> None:
    """ARQ cron: asks Expo for the receipts of stored tickets. A receipt ends its ticket;
    DeviceNotRegistered also deletes the device, and MessageRateExceeded sends the message to
    that device again (send_push). Pending receipts, and a resend that cannot be queued yet,
    wait for the next run."""
    deps = PushDeps.from_context(ctx)
    checked = dead = resent = 0
    try:
        async for batch in deps.store.pending_batches(RECEIPTS_BATCH):
            receipts = await deps.sender.get_receipts(list(batch))
            done: list[str] = []
            gone: list[uuid.UUID] = []
            for ticket_id, receipt in receipts.items():
                ref = batch.get(ticket_id)
                if ref is None:
                    continue
                if receipt.error in RETRYABLE_ERRORS:
                    if not await _resend(deps, ticket_id, ref):
                        continue
                    resent += 1
                elif receipt.error == DEVICE_NOT_REGISTERED:
                    gone.append(ref.device_id)
                done.append(ticket_id)
            await _forget_devices(deps, gone)
            await deps.store.forget_tickets(done)
            checked += len(done)
            dead += len(gone)
    except (PushUnavailableError, RedisError, OSError, SQLAlchemyError):
        # The next run tries again; nothing is lost while the tickets live.
        logger.warning("push_receipts_unavailable", extra={"checked": checked})
        return
    logger.info("push_receipts_checked", extra={"checked": checked, "dead": dead, "resent": resent})


async def _resend(deps: PushDeps, ticket_id: str, ref: TicketRef) -> bool:
    """A receipt asks to try the device again: it goes back to pending and its message is
    queued, unless it is out of attempts (then it failed). True when this ticket is done with;
    False keeps it for the next check, because a run of the message is queued or running
    already and may have read the state before this change."""
    recipient = (await deps.store.delivery(ref.message_id) or {}).get(ref.device_id)
    extra = {"device_id": str(ref.device_id)}
    if recipient is None:
        return True  # the message's state expired
    if recipient.status is Status.ACCEPTED and recipient.ticket_id == ticket_id:
        if recipient.attempts >= deps.max_attempts:
            failed = Recipient(Status.FAILED, recipient.attempts)
            if await deps.store.swap(ref.message_id, ref.device_id, recipient, failed):
                logger.warning(
                    "push_recipient_failed",
                    extra={**extra, "attempts": recipient.attempts, "error": "receipt"},
                )
            return True
        pending = Recipient(Status.PENDING, recipient.attempts)
        if not await deps.store.swap(ref.message_id, ref.device_id, recipient, pending):
            return False  # changed since the read: look again next time
    elif recipient.status is not Status.PENDING:
        return True  # sent again since, or final
    request = await deps.store.request(ref.message_id)
    if request is None:
        return True
    try:
        return await enqueue_push(
            deps.queue,
            request.user_id,
            message_id=request.message_id,
            title_key=request.title_key,
            body_key=request.body_key,
            params=request.params,
            deep_link=request.deep_link,
            timeout_seconds=deps.timeout_seconds,
        )
    except InvalidPushError:
        # The catalog changed since the first send (a deploy): this message cannot go out.
        logger.error("push_resend_invalid", extra=extra)
        return True


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
