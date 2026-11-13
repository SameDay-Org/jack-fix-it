"""A long handle in chat (#241): the other side reads none of it whatever its length, the sender
gets the same warning, the original is kept sealed, the offender flag counts the message, and
no response or log holds a piece of the handle."""

import logging
from datetime import timedelta
from typing import Final

import httpx
import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings
from app.crypto import Sealed
from app.modules.chat.models import MESSAGE_MAX_LENGTH
from app.modules.chat.service import original_associated_data
from app.observability import JsonFormatter
from app.redaction import MASK
from tests.job_world import JobWorld, build_world, make_job
from tests.test_chat_offender_flags import flags, send
from tests.test_chat_originals import WARNING, cipher, keyed_settings, messages_path, stored

# The handle repeats PIECE. Any three characters of it in a row hold one of LEAKS, and no
# clock, uuid, id or log key spells them: each has a letter outside hex (#355).
PIECE: Final = "zq_jx"
LEAKS: Final = ("zq", "jx", "q_j")
BEFORE: Final = "find me "
AFTER: Final = " tonight"
# The lengths of the issue, and the longest handle a message can hold.
LENGTHS: Final = [39, 40, 41, 100, MESSAGE_MAX_LENGTH - len(BEFORE) - len(AFTER) - 1]
RETENTION_DAYS: Final = 90
THRESHOLD: Final = 2


@pytest.fixture
def settings() -> Settings:
    return keyed_settings(
        chat_original_retention_days=RETENTION_DAYS, chat_offender_threshold=THRESHOLD
    )


@pytest.fixture
async def world(db_session: AsyncSession) -> JobWorld:
    return await build_world(db_session)


def _typed(length: int) -> str:
    """A message with an "@" handle of `length` characters, ending on a letter."""
    return BEFORE + "@" + (PIECE * length)[: length - 1] + "k" + AFTER


def _assert_no_piece(*texts: str) -> None:
    for text in texts:
        for leak in LEAKS:
            assert leak not in text


def _logs(caplog: pytest.LogCaptureFixture) -> str:
    formatter = JsonFormatter()
    return "\n".join(formatter.format(r) + r.getMessage() for r in caplog.records)


@pytest.mark.parametrize("length", LENGTHS)
async def test_a_long_handle_is_hidden_whole_and_its_original_sealed(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    caplog: pytest.LogCaptureFixture,
    length: int,
) -> None:
    job = await make_job(db_session, world)
    typed, masked = _typed(length), BEFORE + MASK + AFTER
    assert len(typed) <= MESSAGE_MAX_LENGTH

    with caplog.at_level(logging.DEBUG):
        sent = await send(db_client, job.id, world.customer, typed)
        listed = await db_client.get(messages_path(job.id), headers=world.pro.headers)

    body = sent.json()
    assert (body["body"], body["redacted"], body["warning"]) == (masked, True, WARNING)
    assert listed.status_code == 200, listed.text
    assert [item["body"] for item in listed.json()["items"]] == [masked]
    # Neither answer, to the sender or to the other side, nor any log line holds a piece of it.
    _assert_no_piece(sent.text, listed.text, _logs(caplog))
    message = await stored(db_session, body["id"])
    assert message.body == masked
    assert message.original_ciphertext is not None
    assert message.original_key_id is not None
    assert message.original_expires_at == message.created_at + timedelta(days=RETENTION_DAYS)
    # A long slice of what was typed: two bytes turn up in random ciphertext by chance.
    assert PIECE * 4 in typed
    assert (PIECE * 4).encode() not in message.original_ciphertext
    sealed = Sealed(message.original_key_id, message.original_ciphertext)
    assert cipher().decrypt(sealed, original_associated_data(message.id)) == typed


async def test_long_handles_count_for_the_offender_flag(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    caplog: pytest.LogCaptureFixture,
) -> None:
    job = await make_job(db_session, world)

    with caplog.at_level(logging.DEBUG):
        for length in (41, 100):
            sent = await send(db_client, job.id, world.customer, _typed(length))
            assert sent.json()["warning"] == WARNING

    [flag] = await flags(db_session, world.customer.id)
    assert (flag.job_id, flag.window_count, flag.resolved_at) == (job.id, THRESHOLD, None)
    [record] = [r for r in caplog.records if r.getMessage() == "chat_offender_flagged"]
    assert record.__dict__["window_count"] == THRESHOLD
    _assert_no_piece(_logs(caplog))
