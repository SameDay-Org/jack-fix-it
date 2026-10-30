"""scripts/resolve_payout_account.py: staff settle an unresolved Stripe account create (#39).
Never calls Stripe: the payouts tests' fake stands in for the wrapper."""

import asyncio
import io
import json
import logging
import re
import uuid
from collections.abc import Callable, Iterator
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings
from app.integrations.stripe_connect import StripeConnect, StripeUnavailableError
from app.modules.pros.models import ProProfile
from app.modules.users.models import User
from app.modules.users.types import UserRole
from app.observability import JsonFormatter
from scripts.resolve_payout_account import Io, run
from tests.conftest import make_settings
from tests.test_create_staff_user import sessions_of
from tests.test_payouts_onboarding_api import FakeStripe

ACCOUNT = "acct_resolve0fixture1"
ACCOUNT_ID = re.compile(r"acct_[A-Za-z0-9]")  # any account id, not the help's acct_...
EMAIL_DOMAIN = "@resolve.example.invalid"
# Older than the reconcile window (the app answers 409), younger than Stripe's key retention.
YOUNG = timedelta(hours=23)
OLD = timedelta(hours=25)


@pytest.fixture
def settings() -> Settings:
    return make_settings(stripe_secret_key=None)


class Terminal:
    """Scripted answers for input(), and the captured output. `while_asked` runs while the
    prompt waits (the script asks from a worker thread)."""

    def __init__(
        self, answers: list[str] | None = None, while_asked: Callable[[], None] | None = None
    ) -> None:
        self.answers: Iterator[str] = iter(answers or [])
        self.while_asked = while_asked
        self.prompts: list[str] = []
        self.out = io.StringIO()
        self.io = Io(prompt=self._prompt, out=self.out)

    def _prompt(self, text: str) -> str:
        self.prompts.append(text)
        if self.while_asked is not None:
            self.while_asked()
        return next(self.answers)

    @property
    def text(self) -> str:
        return self.out.getvalue()


async def make_profile(
    session: AsyncSession, *, account_id: str | None = None, attempted: timedelta | None = OLD
) -> uuid.UUID:
    """A committed profile's id (a refusal rolls the session back, expiring the row)."""
    user = User(
        email=f"pro-{uuid.uuid4().hex[:8]}{EMAIL_DOMAIN}", password_hash="x", role=UserRole.PRO
    )
    session.add(user)
    await session.flush()
    profile = ProProfile(
        user_id=user.id,
        stripe_account_id=account_id,
        stripe_account_requested_at=None if attempted is None else datetime.now(UTC) - attempted,
    )
    session.add(profile)
    await session.commit()
    return profile.id


async def stored(session: AsyncSession, pro_id: uuid.UUID) -> tuple[str | None, datetime | None]:
    row = (
        await session.execute(
            select(ProProfile.stripe_account_id, ProProfile.stripe_account_requested_at).where(
                ProProfile.id == pro_id
            )
        )
    ).one()
    return row[0], row[1]


async def resolve(
    session: AsyncSession,
    settings: Settings,
    stripe: StripeConnect | None,
    terminal: Terminal,
    caplog: pytest.LogCaptureFixture,
    *argv: str,
) -> tuple[int, list[dict[str, object]]]:
    """Runs the script; asserts that neither its output nor its logs hold an account id or an
    email, and returns the exit code and the JSON log lines."""
    with caplog.at_level(logging.DEBUG):
        code = await run(list(argv), sessions_of(session), settings, stripe, terminal.io)
    formatter = JsonFormatter()
    lines = [formatter.format(record) for record in caplog.records]
    for text in (terminal.text, *lines):
        assert not ACCOUNT_ID.search(text), text
        assert EMAIL_DOMAIN not in text, text
    return code, [json.loads(line) for line in lines]


def resolved(logs: list[dict[str, object]]) -> list[tuple[object, object]]:
    return [
        (log["pro_id"], log["action"])
        for log in logs
        if log["message"] == "payouts_account_resolved"
    ]


async def test_adopt_stores_the_account_after_confirming(
    db_session: AsyncSession, settings: Settings, caplog: pytest.LogCaptureFixture
) -> None:
    pro_id = await make_profile(db_session)
    stripe = FakeStripe(profiles={ACCOUNT: str(pro_id)})
    terminal = Terminal(answers=["y"])

    code, logs = await resolve(
        db_session, settings, stripe, terminal, caplog, "--pro", str(pro_id), "--adopt", ACCOUNT
    )

    assert code == 0
    assert (await stored(db_session, pro_id))[0] == ACCOUNT
    assert terminal.prompts == ["Proceed? [y/N] "]
    assert terminal.text.splitlines()[-1] == f"Pro profile {pro_id} now has the given account."
    assert resolved(logs) == [(str(pro_id), "adopt")]


async def test_adopt_not_confirmed_changes_nothing(
    db_session: AsyncSession, settings: Settings, caplog: pytest.LogCaptureFixture
) -> None:
    pro_id = await make_profile(db_session)
    before = await stored(db_session, pro_id)
    stripe = FakeStripe(profiles={ACCOUNT: str(pro_id)})
    terminal = Terminal(answers=["n"])

    code, logs = await resolve(
        db_session, settings, stripe, terminal, caplog, "--pro", str(pro_id), "--adopt", ACCOUNT
    )

    assert code == 1
    assert "Not confirmed; nothing changed." in terminal.text
    assert await stored(db_session, pro_id) == before
    assert resolved(logs) == []


@pytest.mark.parametrize("remote", ["another_profile", "no_metadata", "missing", "unavailable"])
async def test_adopt_refuses_an_account_that_is_not_this_profiles(
    db_session: AsyncSession, settings: Settings, caplog: pytest.LogCaptureFixture, remote: str
) -> None:
    """The account's metadata must name this profile: another profile's, an account without
    that metadata, or one Stripe does not know is refused; so is any account while Stripe is
    unreachable. Nothing is asked or stored."""
    pro_id = await make_profile(db_session)
    before = await stored(db_session, pro_id)
    stripe = FakeStripe()
    if remote == "another_profile":
        stripe.profiles[ACCOUNT] = str(uuid.uuid4())
    elif remote == "no_metadata":
        stripe.profiles[ACCOUNT] = ""
    elif remote == "unavailable":
        stripe.errors["retrieve"] = StripeUnavailableError()
    terminal = Terminal()

    code, logs = await resolve(
        db_session,
        settings,
        stripe,
        terminal,
        caplog,
        *("--pro", str(pro_id), "--adopt", ACCOUNT, "--yes"),
    )

    assert code == 1
    assert terminal.text.startswith("Error: ")
    assert "nothing changed" in terminal.text
    assert await stored(db_session, pro_id) == before
    assert resolved(logs) == []


@pytest.mark.parametrize("case", ["has_account", "unknown_profile"])
async def test_adopt_refuses_a_profile_with_an_account_or_none(
    db_session: AsyncSession, settings: Settings, caplog: pytest.LogCaptureFixture, case: str
) -> None:
    pro_id = await make_profile(db_session, account_id="acct_resolve0kept")
    target = pro_id if case == "has_account" else uuid.uuid4()
    stripe = FakeStripe(profiles={ACCOUNT: str(target)})
    terminal = Terminal()

    code, logs = await resolve(
        db_session,
        settings,
        stripe,
        terminal,
        caplog,
        *("--pro", str(target), "--adopt", ACCOUNT, "--yes"),
    )

    assert code == 1
    expected = "already has a payout account" if case == "has_account" else "No pro profile"
    assert expected in terminal.text
    assert (await stored(db_session, pro_id))[0] == "acct_resolve0kept"
    assert resolved(logs) == []


async def test_adopt_refuses_text_that_is_not_an_account_id(
    db_session: AsyncSession, settings: Settings, caplog: pytest.LogCaptureFixture
) -> None:
    """What was typed is not repeated: it could be anything the operator pasted."""
    pro_id = await make_profile(db_session)
    before = await stored(db_session, pro_id)
    stripe = FakeStripe(errors={"retrieve": AssertionError("Stripe must not be called")})
    terminal = Terminal()

    code, _ = await resolve(
        db_session,
        settings,
        stripe,
        terminal,
        caplog,
        *("--pro", str(pro_id), "--adopt", "pasted-secret-text", "--yes"),
    )

    assert code == 1
    assert "takes a Stripe account id" in terminal.text
    assert "pasted-secret-text" not in terminal.text
    assert await stored(db_session, pro_id) == before


async def test_adopt_without_stripe_configured_is_refused(
    db_session: AsyncSession, settings: Settings, caplog: pytest.LogCaptureFixture
) -> None:
    pro_id = await make_profile(db_session)
    terminal = Terminal()

    code, _ = await resolve(
        db_session,
        settings,
        None,
        terminal,
        caplog,
        *("--pro", str(pro_id), "--adopt", ACCOUNT, "--yes"),
    )

    assert code == 1
    assert "STRIPE_SECRET_KEY" in terminal.text
    assert (await stored(db_session, pro_id))[0] is None


async def test_allow_new_clears_an_attempt_older_than_24_hours(
    db_session: AsyncSession, settings: Settings, caplog: pytest.LogCaptureFixture
) -> None:
    """Needs no Stripe key: it only forgets the attempt, so the next link creates."""
    pro_id = await make_profile(db_session, attempted=OLD)
    terminal = Terminal()

    code, logs = await resolve(
        db_session,
        settings,
        None,
        terminal,
        caplog,
        "--pro",
        str(pro_id),
        "--allow-new",
        "--yes",
    )

    assert code == 0
    assert terminal.prompts == []
    assert await stored(db_session, pro_id) == (None, None)
    assert terminal.text.splitlines()[-1] == (f"Pro profile {pro_id} can create a new account.")
    assert resolved(logs) == [(str(pro_id), "allow_new")]


@pytest.mark.parametrize("case", ["younger_than_24_hours", "never_attempted", "has_account"])
async def test_allow_new_refuses(
    db_session: AsyncSession, settings: Settings, caplog: pytest.LogCaptureFixture, case: str
) -> None:
    pro_id = await make_profile(
        db_session,
        account_id="acct_resolve0kept" if case == "has_account" else None,
        attempted={"younger_than_24_hours": YOUNG, "never_attempted": None}.get(case, OLD),
    )
    before = await stored(db_session, pro_id)
    terminal = Terminal(answers=["y"])

    code, logs = await resolve(
        db_session, settings, None, terminal, caplog, "--pro", str(pro_id), "--allow-new"
    )

    assert code == 1
    expected = {
        "younger_than_24_hours": "less than 24 hours ago",
        "never_attempted": "no account create to clear",
        "has_account": "already has a payout account",
    }[case]
    assert expected in terminal.text
    assert terminal.prompts == []
    assert await stored(db_session, pro_id) == before
    assert resolved(logs) == []


async def test_adopt_refuses_an_account_another_profile_holds(
    db_session: AsyncSession, settings: Settings, caplog: pytest.LogCaptureFixture
) -> None:
    """Possible only if the metadata was edited in the dashboard; the unique column refuses it,
    and the database's detail (which names the account) is not shown."""
    holder = await make_profile(db_session, account_id=ACCOUNT)
    pro_id = await make_profile(db_session)
    stripe = FakeStripe(profiles={ACCOUNT: str(pro_id)})
    terminal = Terminal()

    code, logs = await resolve(
        db_session,
        settings,
        stripe,
        terminal,
        caplog,
        *("--pro", str(pro_id), "--adopt", ACCOUNT, "--yes"),
    )

    assert code == 1
    assert "already another profile's payout account" in terminal.text
    assert (await stored(db_session, pro_id))[0] is None
    assert (await stored(db_session, holder))[0] == ACCOUNT
    assert resolved(logs) == []


async def test_eof_at_the_prompt_is_not_confirmed(
    db_session: AsyncSession, settings: Settings, caplog: pytest.LogCaptureFixture
) -> None:
    pro_id = await make_profile(db_session, attempted=OLD)
    before = await stored(db_session, pro_id)
    terminal = Terminal(answers=[])  # input() at end of file

    def eof(text: str) -> str:
        raise EOFError

    terminal.io.prompt = eof

    code, _ = await resolve(
        db_session, settings, None, terminal, caplog, "--pro", str(pro_id), "--allow-new"
    )

    assert code == 1
    assert "Not confirmed; nothing changed." in terminal.text
    assert await stored(db_session, pro_id) == before


@pytest.mark.parametrize(
    ("action", "meanwhile"),
    [("adopt", "account_stored"), ("adopt", "metadata_changed"), ("allow_new", "account_stored")],
)
async def test_apply_checks_again_what_changed_during_the_prompt(
    db_session: AsyncSession,
    settings: Settings,
    caplog: pytest.LogCaptureFixture,
    action: str,
    meanwhile: str,
) -> None:
    """The preview's checks are not trusted: while the operator reads the prompt, the pro's own
    call may store an account, or the account's metadata may change; the apply, under the row
    lock, finds it and changes nothing."""
    pro_id = await make_profile(db_session, attempted=OLD)
    stripe = FakeStripe(profiles={ACCOUNT: str(pro_id)})
    loop = asyncio.get_running_loop()

    async def store_meanwhile() -> None:
        await db_session.execute(
            update(ProProfile)
            .where(ProProfile.id == pro_id)
            .values(stripe_account_id="acct_resolve0meanwhile")
        )
        await db_session.commit()

    def change() -> None:
        if meanwhile == "metadata_changed":
            stripe.profiles[ACCOUNT] = str(uuid.uuid4())
        else:
            asyncio.run_coroutine_threadsafe(store_meanwhile(), loop).result(timeout=10)

    terminal = Terminal(answers=["y"], while_asked=change)
    argv = ["--adopt", ACCOUNT] if action == "adopt" else ["--allow-new"]

    code, logs = await resolve(
        db_session, settings, stripe, terminal, caplog, "--pro", str(pro_id), *argv
    )

    assert code == 1
    assert terminal.prompts == ["Proceed? [y/N] "]
    expected = (
        "does not name this profile"
        if meanwhile == "metadata_changed"
        else "already has a payout account"
    )
    assert expected in terminal.text
    stored_account, attempted = await stored(db_session, pro_id)
    assert stored_account == (None if meanwhile == "metadata_changed" else "acct_resolve0meanwhile")
    assert attempted is not None
    assert resolved(logs) == []


@pytest.mark.parametrize(
    "argv",
    [
        ["--adopt", ACCOUNT],
        ["--pro", ACCOUNT, "--adopt", "3f0c6a2e-1111-4222-8333-444455556666"],
        ["--pro", f"pro{EMAIL_DOMAIN}", "--allow-new"],
        ["--pro", "3f0c6a2e-1111-4222-8333-444455556666"],
        ["--pro", "3f0c6a2e-1111-4222-8333-444455556666", "--adopt", ACCOUNT, "--allow-new"],
        ["--pro", "3f0c6a2e-1111-4222-8333-444455556666", "--allow-new", ACCOUNT],
    ],
)
async def test_flags_need_one_profile_and_one_action(
    argv: list[str],
    settings: Settings,
    db_session: AsyncSession,
    capsys: pytest.CaptureFixture[str],
) -> None:
    with pytest.raises(SystemExit) as exit_info:
        await run(argv, sessions_of(db_session), settings, None, Terminal().io)

    assert exit_info.value.code == 2
    err = capsys.readouterr().err
    assert ACCOUNT not in err
    assert EMAIL_DOMAIN not in err
