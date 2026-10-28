"""The push copy and the deep-link allowlist (D10.3, #54)."""

import asyncio
import re
import uuid

import pytest
from arq.connections import ArqRedis

from app.modules.notifications import catalog, deep_links
from app.modules.notifications.service import InvalidPushError, PushRequest, enqueue_push

REQUEST_PATH = f"/requests/{uuid.UUID(int=1)}"
ENQUEUE_TIMEOUT = 0.05


def test_en_es_parity() -> None:
    assert set(catalog.CATALOG) == {"en", "es"}
    assert set(catalog.CATALOG["en"]) == set(catalog.CATALOG["es"])
    for key in catalog.catalog_keys():
        en, es = catalog.CATALOG["en"][key], catalog.CATALOG["es"][key]
        assert en.strip()
        assert es.strip()
        assert catalog.placeholders(en) == catalog.placeholders(es)


def test_no_personal_placeholders() -> None:
    # Titles and bodies show on lock screens: only identifiers from the allowlist.
    for copy in catalog.CATALOG.values():
        for key, text in copy.items():
            assert catalog.placeholders(text) <= catalog.PLACEHOLDERS, key
            # No positional or attribute-style fields that could reach other data.
            assert not re.search(r"\{\s*\}|\{[^}]*[.\[]", text), key


def test_render_uses_locale_and_falls_back_to_english() -> None:
    params = {"public_code": "JF-000124"}

    assert catalog.render("es", "push.test.body", params).startswith("Esta es")
    assert catalog.render("fr", "push.test.body", params) == catalog.render(
        "en", "push.test.body", params
    )
    assert "JF-000124" in catalog.render("en", "push.test.body", params)


@pytest.mark.parametrize(
    "path",
    [
        f"/requests/{uuid.UUID(int=1)}",
        f"/jobs/{uuid.UUID(int=2)}",
        f"/quotes/{uuid.UUID(int=3)}",
        f"/opportunities/{uuid.UUID(int=4)}",
    ],
)
def test_allowed_deep_links(path: str) -> None:
    assert deep_links.is_allowed(path)


@pytest.mark.parametrize(
    "path",
    [
        "https://evil.example/requests/1",
        f"/requests/{uuid.UUID(int=1)}/../admin",
        f"/requests/{uuid.UUID(int=1)}?x=1",
        "/requests/not-a-uuid",
        f"/users/{uuid.UUID(int=1)}",
        f"//evil.example/requests/{uuid.UUID(int=1)}",
        "",
    ],
)
def test_deep_link_outside_allowlist_rejected(path: str) -> None:
    assert not deep_links.is_allowed(path)
    request = PushRequest(
        uuid.uuid4(), "m1", "push.test.title", "push.test.body", {"public_code": "JF-1"}, path
    )
    with pytest.raises(InvalidPushError):
        request.validate()


@pytest.mark.parametrize(
    "overrides",
    [
        {"title_key": "push.unknown"},
        {"params": {}},
        {"params": {"public_code": "JF-1", "name": "Ana"}},
        {"params": {"public_code": "x" * 65}},
        {"message_id": "has spaces"},
        {"message_id": ""},
    ],
    ids=["unknown_key", "missing_param", "extra_param", "long_param", "bad_id", "empty_id"],
)
def test_invalid_push_requests_rejected(overrides: dict[str, object]) -> None:
    values: dict[str, object] = {
        "user_id": uuid.uuid4(),
        "message_id": "test:1",
        "title_key": "push.test.title",
        "body_key": "push.test.body",
        "params": {"public_code": "JF-1"},
        "deep_link": REQUEST_PATH,
    }
    values.update(overrides)

    with pytest.raises(InvalidPushError):
        PushRequest(**values).validate()  # type: ignore[arg-type]  # deliberately loose values


class FakeQueue:
    def __init__(self) -> None:
        self.jobs: dict[str, tuple[str, tuple[object, ...]]] = {}

    async def enqueue_job(self, function: str, *args: object, _job_id: str | None = None) -> object:
        # Like ARQ: a job id that already exists is not queued again.
        assert _job_id is not None
        if _job_id in self.jobs:
            return None
        self.jobs[_job_id] = (function, args)
        return object()


async def test_enqueue_push_uses_a_job_id_per_message() -> None:
    queue = FakeQueue()
    user_id = uuid.uuid4()

    queued = [
        await enqueue_push(
            queue,
            user_id,
            message_id="test:1",
            title_key="push.test.title",
            body_key="push.test.body",
            params={"public_code": "JF-1"},
            deep_link=REQUEST_PATH,
            timeout_seconds=ENQUEUE_TIMEOUT,
        )
        for _ in range(2)
    ]

    assert queued == [True, False]  # the second finds the first one waiting
    assert list(queue.jobs) == ["push:test:1"]
    function, args = queue.jobs["push:test:1"]
    assert function == "send_push"
    assert args[0] == str(user_id)


async def test_enqueue_push_validates_before_queuing() -> None:
    queue = FakeQueue()

    with pytest.raises(InvalidPushError):
        await enqueue_push(
            queue,
            uuid.uuid4(),
            message_id="test:1",
            title_key="push.test.title",
            body_key="push.test.body",
            params={"public_code": "JF-1"},
            deep_link="https://evil.example",
            timeout_seconds=ENQUEUE_TIMEOUT,
        )

    assert queue.jobs == {}


async def test_enqueue_push_gives_up_on_a_hung_redis(silent_redis_url: str) -> None:
    hung = ArqRedis.from_url(silent_redis_url)  # like the API's pool: no socket timeout
    task = asyncio.create_task(
        enqueue_push(
            hung,
            uuid.uuid4(),
            message_id="test:1",
            title_key="push.test.title",
            body_key="push.test.body",
            params={"public_code": "JF-1"},
            deep_link=REQUEST_PATH,
            timeout_seconds=ENQUEUE_TIMEOUT,
        )
    )
    try:
        # Far past the deadline, yet short: without it the call would still be waiting.
        done, _ = await asyncio.wait({task}, timeout=100 * ENQUEUE_TIMEOUT)
        assert task in done, "enqueue_push is still waiting on a Redis that never answers"
        with pytest.raises(TimeoutError):
            task.result()
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
        await hung.aclose()


# Transactional pushes (D10.4, #55)

NEW_KEYS = (
    "push.new_request.title",
    "push.new_request.body",
    "push.new_quote.title",
    "push.new_quote.body",
    "push.quote_accepted.title",
    "push.quote_accepted.body",
)


def test_catalog_keys_exist_in_en_and_es_with_only_public_code() -> None:
    for locale in ("en", "es"):
        copy = catalog.CATALOG[locale]
        for key in NEW_KEYS:
            assert copy[key].strip()
            assert catalog.placeholders(copy[key]) <= {"public_code"}
        for kind in ("new_request", "new_quote", "quote_accepted"):
            assert catalog.placeholders(copy[f"push.{kind}.title"]) == set()
            assert catalog.placeholders(copy[f"push.{kind}.body"]) == {"public_code"}
    params = {"public_code": "JF-000124"}
    assert catalog.render("en", "push.new_request.body", params) == (
        "Request JF-000124 is waiting for your quote."
    )
    assert catalog.render("en", "push.new_quote.body", params) == (
        "A pro sent a quote for JF-000124."
    )
    # "Presupuesto", as the app's Spanish locale calls a quote.
    assert catalog.render("es", "push.new_request.body", params) == (
        "La solicitud JF-000124 espera tu presupuesto."
    )
    assert catalog.render("es", "push.new_quote.title", params) == "Tienes un nuevo presupuesto"


def test_quote_accepted_copy_in_en_and_es() -> None:
    """To the pro (#55): payment comes after acceptance (#58, #61), so the copy never says
    the job is booked."""
    params = {"public_code": "JF-000124"}

    assert catalog.render("en", "push.quote_accepted.title", params) == "Your quote was accepted"
    assert catalog.render("en", "push.quote_accepted.body", params) == (
        "The customer accepted your quote for JF-000124. "
        "We'll confirm the job once payment goes through."
    )
    assert catalog.render("es", "push.quote_accepted.title", params) == "Aceptaron tu presupuesto"
    assert catalog.render("es", "push.quote_accepted.body", params) == (
        "El cliente aceptó tu presupuesto para JF-000124. "
        "Confirmaremos el trabajo cuando se procese el pago."
    )


def test_opportunities_deep_link_allowed_and_others_still_refused() -> None:
    dispatch_id = uuid.UUID(int=4)

    assert deep_links.is_allowed(f"/opportunities/{dispatch_id}")
    for path in (
        f"/opportunities/{dispatch_id}/quote",
        f"/opportunities/{dispatch_id}?x=1",
        "/opportunities/not-a-uuid",
        "/opportunities/",
        f"/opportunity/{dispatch_id}",
        f"https://evil.example/opportunities/{dispatch_id}",
        f"//evil.example/opportunities/{dispatch_id}",
        f"/pros/me/opportunities/{dispatch_id}",
    ):
        assert not deep_links.is_allowed(path), path
