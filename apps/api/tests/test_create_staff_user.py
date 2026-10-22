"""scripts/create_staff_user.py: staff accounts from the terminal (#155)."""

import io
from collections.abc import AsyncIterator, Callable, Iterator
from contextlib import AbstractAsyncContextManager, asynccontextmanager

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings
from app.modules.auth import security
from app.modules.users.models import User
from app.modules.users.types import UserRole
from scripts.create_staff_user import Io, run
from tests.conftest import make_settings

EMAIL = "Staff.Person@Example.com"
STORED_EMAIL = "staff.person@example.com"
PASSWORD = "a-strong-staff-password"
MIN_LENGTH = 12  # not the default (10), so the tests prove it comes from the setting


@pytest.fixture
def settings() -> Settings:
    return make_settings(password_min_length=MIN_LENGTH)


def sessions_of(
    session: AsyncSession,
) -> Callable[[], AbstractAsyncContextManager[AsyncSession]]:
    @asynccontextmanager
    async def factory() -> AsyncIterator[AsyncSession]:
        yield session

    return factory


class Terminal:
    """Scripted answers for input() and getpass(), and the captured output."""

    def __init__(
        self,
        answers: list[str] | None = None,
        secrets: list[str] | None = None,
        environ: dict[str, str] | None = None,
    ) -> None:
        self.answers: Iterator[str] = iter(answers or [])
        self.secrets: Iterator[str] = iter(secrets or [])
        self.prompts: list[str] = []
        self.out = io.StringIO()
        self.io = Io(
            prompt=self._prompt,
            secret=self._secret,
            environ=environ or {},
            out=self.out,
        )

    def _prompt(self, text: str) -> str:
        self.prompts.append(text)
        return next(self.answers)

    def _secret(self, text: str) -> str:
        self.prompts.append(text)
        return next(self.secrets)

    @property
    def text(self) -> str:
        return self.out.getvalue()


async def staff_cli(
    session: AsyncSession, settings: Settings, terminal: Terminal, *argv: str
) -> int:
    return await run(list(argv), sessions_of(session), settings, terminal.io)


async def user_by_email(session: AsyncSession, email: str = STORED_EMAIL) -> User | None:
    statement = select(User).where(User.email == email).execution_options(populate_existing=True)
    return await session.scalar(statement)


async def make_user(session: AsyncSession, role: UserRole, password_hash: str) -> User:
    user = User(email=STORED_EMAIL, password_hash=password_hash, role=role)
    session.add(user)
    await session.flush()
    return user


@pytest.mark.parametrize("role", ["admin", "agent"])
async def test_create_staff_interactively(
    db_session: AsyncSession, settings: Settings, role: str
) -> None:
    terminal = Terminal(answers=[EMAIL, role], secrets=[PASSWORD, PASSWORD])

    code = await staff_cli(db_session, settings, terminal)

    assert code == 0
    user = await user_by_email(db_session)
    assert user is not None
    assert user.role.value == role
    assert security.verify_password(user.password_hash, PASSWORD)
    assert terminal.text.strip() == f"Created user {user.id} with role {role}."
    assert terminal.prompts == [
        "Email: ",
        "Role (admin, agent): ",
        "Password: ",
        "Repeat the password: ",
    ]


async def test_create_agent_non_interactive(db_session: AsyncSession, settings: Settings) -> None:
    terminal = Terminal(environ={"STAFF_PASSWORD": PASSWORD, "OTHER": "ignored-value-123"})

    code = await staff_cli(
        db_session, settings, terminal, "--email", EMAIL, "--role", "agent",
        "--password-env", "STAFF_PASSWORD",
    )  # fmt: skip

    assert code == 0
    user = await user_by_email(db_session)
    assert user is not None
    assert user.role is UserRole.AGENT
    assert security.verify_password(user.password_hash, PASSWORD)
    assert terminal.prompts == []


async def test_non_interactive_reads_only_the_named_env_var(
    db_session: AsyncSession, settings: Settings
) -> None:
    terminal = Terminal(environ={"STAFF_PASSWORD": PASSWORD})

    code = await staff_cli(
        db_session, settings, terminal, "--email", EMAIL, "--role", "admin",
        "--password-env", "ANOTHER_NAME",
    )  # fmt: skip

    assert code == 1
    assert "ANOTHER_NAME is not set" in terminal.text
    assert await user_by_email(db_session) is None


@pytest.mark.parametrize("argv", [["--password-env", "X"], ["--email", EMAIL, "--yes"]])
def test_flags_need_their_mode(argv: list[str], settings: Settings) -> None:
    # --password-env needs --email and --role; --yes only exists without a prompt.
    import asyncio

    with pytest.raises(SystemExit) as exit_info:
        asyncio.run(run(argv, sessions_of(None), settings, Terminal().io))  # type: ignore[arg-type]  # never reached
    assert exit_info.value.code == 2


@pytest.mark.parametrize("existing_role", [UserRole.CUSTOMER, UserRole.PRO, UserRole.AGENT])
async def test_refuse_duplicate_without_promote(
    db_session: AsyncSession, settings: Settings, existing_role: UserRole
) -> None:
    user = await make_user(db_session, existing_role, password_hash="unchanged-hash")
    terminal = Terminal(answers=[EMAIL, "admin"])

    code = await staff_cli(db_session, settings, terminal)

    assert code == 1
    assert "--promote" in terminal.text
    assert str(user.id) in terminal.text
    refreshed = await user_by_email(db_session)
    assert refreshed is not None
    assert (refreshed.role, refreshed.password_hash) == (existing_role, "unchanged-hash")
    assert "Password: " not in terminal.prompts  # no password asked for an existing account


async def test_promote_with_confirmation(db_session: AsyncSession, settings: Settings) -> None:
    user = await make_user(db_session, UserRole.PRO, password_hash="unchanged-hash")
    declined = Terminal(answers=[EMAIL, "agent", "n"])
    confirmed = Terminal(answers=[EMAIL, "agent", "y"])

    declined_code = await staff_cli(db_session, settings, declined, "--promote")
    after_decline = await user_by_email(db_session)
    assert after_decline is not None
    role_after_decline = after_decline.role  # the next read refreshes this same object
    confirmed_code = await staff_cli(db_session, settings, confirmed, "--promote")

    assert declined_code == 1
    assert role_after_decline is UserRole.PRO
    assert confirmed_code == 0
    promoted = await user_by_email(db_session)
    assert promoted is not None
    assert (promoted.role, promoted.password_hash) == (UserRole.AGENT, "unchanged-hash")
    assert f"Will change user {user.id} from pro to agent" in confirmed.text


async def test_promote_non_interactive_needs_yes(
    db_session: AsyncSession, settings: Settings
) -> None:
    await make_user(db_session, UserRole.CUSTOMER, password_hash="x")
    argv = ["--email", EMAIL, "--role", "admin", "--password-env", "P", "--promote"]

    without_yes = await staff_cli(db_session, settings, Terminal(environ={"P": PASSWORD}), *argv)
    with_yes = await staff_cli(
        db_session, settings, Terminal(environ={"P": PASSWORD}), *argv, "--yes"
    )

    assert (without_yes, with_yes) == (1, 0)
    user = await user_by_email(db_session)
    assert user is not None
    assert user.role is UserRole.ADMIN


async def test_never_demotes(db_session: AsyncSession, settings: Settings) -> None:
    await make_user(db_session, UserRole.ADMIN, password_hash="x")
    terminal = Terminal(answers=[EMAIL, "agent", "y"])

    code = await staff_cli(db_session, settings, terminal, "--promote")

    assert code == 1
    assert "Refusing to demote" in terminal.text
    user = await user_by_email(db_session)
    assert user is not None
    assert user.role is UserRole.ADMIN


@pytest.mark.parametrize(
    "secrets",
    [["short-pass", "short-pass"], [PASSWORD, PASSWORD + "x"], ["x" * 129, "x" * 129]],
    ids=["too_short", "mismatch", "too_long"],
)
async def test_weak_password_rejected(
    db_session: AsyncSession, settings: Settings, secrets: list[str]
) -> None:
    terminal = Terminal(answers=[EMAIL, "admin"], secrets=secrets)

    code = await staff_cli(db_session, settings, terminal)

    assert code == 1
    assert await user_by_email(db_session) is None


@pytest.mark.parametrize(
    ("answers", "message"),
    [(["not-an-email", "admin"], "not a valid email"), ([EMAIL, "owner"], "must be one of")],
)
async def test_bad_email_or_role(
    db_session: AsyncSession, settings: Settings, answers: list[str], message: str
) -> None:
    terminal = Terminal(answers=answers, secrets=[PASSWORD, PASSWORD])

    assert await staff_cli(db_session, settings, terminal) == 1
    assert message in terminal.text


async def test_password_never_in_argv_or_output(
    db_session: AsyncSession, settings: Settings, capsys: pytest.CaptureFixture[str]
) -> None:
    # There is no password flag: a password typed as an argument is refused, and argparse's
    # error does not echo it. "--password" is not an abbreviation of "--password-env".
    full = ["--email", EMAIL, "--role", "admin"]
    for argv in (
        ["--password", PASSWORD],
        [f"--password={PASSWORD}"],
        [PASSWORD],
        # With abbreviations on, this would be --password-env, and the "variable not set"
        # refusal would print the password as the variable's name.
        [*full, "--password", PASSWORD],
    ):
        with pytest.raises(SystemExit):
            await staff_cli(db_session, settings, Terminal(), *argv)
    terminal = Terminal(environ={"STAFF_PASSWORD": PASSWORD})
    await staff_cli(
        db_session, settings, terminal, "--email", EMAIL, "--role", "admin",
        "--password-env", "STAFF_PASSWORD",
    )  # fmt: skip

    captured = capsys.readouterr()
    user = await user_by_email(db_session)
    assert user is not None
    for output in (captured.out, captured.err, terminal.text):
        assert PASSWORD not in output
        assert user.password_hash not in output
        assert STORED_EMAIL not in output
