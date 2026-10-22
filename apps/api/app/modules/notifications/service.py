"""Notifications: the API features use to push to a user (D10.3, #54).

enqueue_push validates the message (catalog keys, placeholders, deep link) and hands it to the
worker (send_push), with an ARQ job id derived from `message_id`: the same event enqueued twice
sends once. The text is resolved in the worker, in the user's locale at send time.
"""

import asyncio
import re
import uuid
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any, Final, Protocol

from app.modules.notifications import catalog, deep_links

SEND_PUSH_TASK: Final = "send_push"
# A stable id per event, chosen by the feature, e.g. "quote_ready:<quote id>".
MESSAGE_ID_PATTERN: Final = re.compile(r"[A-Za-z0-9:_-]{1,128}")
MAX_PARAM_LENGTH: Final = 64


class InvalidPushError(ValueError):
    """A programming error in the caller: unknown key, wrong params or a link not allowed."""


class JobQueue(Protocol):
    async def enqueue_job(self, function: str, *args: Any, _job_id: str | None = None) -> object:
        """ARQ's ArqRedis.enqueue_job: does nothing when a job with this id already exists."""
        ...


@dataclass(frozen=True)
class PushRequest:
    user_id: uuid.UUID
    message_id: str
    title_key: str
    body_key: str
    params: Mapping[str, str]
    deep_link: str

    def validate(self) -> None:
        if not MESSAGE_ID_PATTERN.fullmatch(self.message_id):
            raise InvalidPushError("message_id")
        known = catalog.catalog_keys()
        if self.title_key not in known or self.body_key not in known:
            raise InvalidPushError("unknown catalog key")
        needed = set()
        for copy in catalog.CATALOG.values():
            needed |= catalog.placeholders(copy[self.title_key])
            needed |= catalog.placeholders(copy[self.body_key])
        if set(self.params) != needed or not needed <= catalog.PLACEHOLDERS:
            raise InvalidPushError("params do not match the copy's placeholders")
        if any(not isinstance(v, str) or len(v) > MAX_PARAM_LENGTH for v in self.params.values()):
            raise InvalidPushError("param values are short strings")
        if not deep_links.is_allowed(self.deep_link):
            raise InvalidPushError("deep link not allowed")

    @property
    def job_id(self) -> str:
        return f"push:{self.message_id}"


async def enqueue_push(
    queue: JobQueue,
    user_id: uuid.UUID,
    *,
    message_id: str,
    title_key: str,
    body_key: str,
    params: Mapping[str, str],
    deep_link: str,
    timeout_seconds: float,
) -> bool:
    """Queues a push to every device of the user. Raises InvalidPushError before queuing.

    False when a job for this message id is already queued or running: that job sends it.
    Waits at most `timeout_seconds` (PUSH_SEND_TIMEOUT_SECONDS) on Redis, then raises
    TimeoutError; a Redis failure raises RedisError or OSError. The caller decides whether the
    push may be lost: call it after the commit of the change it announces, and log a failure
    (ids only) rather than fail a request that already did its work.
    """
    request = PushRequest(user_id, message_id, title_key, body_key, dict(params), deep_link)
    request.validate()
    async with asyncio.timeout(timeout_seconds):
        job = await queue.enqueue_job(
            SEND_PUSH_TASK,
            str(user_id),
            message_id,
            title_key,
            body_key,
            dict(params),
            deep_link,
            _job_id=request.job_id,
        )
    return job is not None
