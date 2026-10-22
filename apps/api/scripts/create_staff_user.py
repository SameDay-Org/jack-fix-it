"""Create a staff account (admin or agent): `uv run python -m scripts.create_staff_user`.

Public registration only creates customers and pros, by design (#25), so the first admin and
every BDC agent come from here, run by someone with database access (#155). There is no HTTP
endpoint.

- Interactive (no --password-env): asks for the email and the role, then the password twice
  with getpass (never echoed).
- Non-interactive (CI or setup): --email and --role as flags, and the password only from the
  environment variable named by --password-env. A password is never a command-line argument.
- An existing email is refused unless --promote is given. Promoting changes the role only,
  never the password, and never demotes; it asks to confirm (--yes skips that, non-interactive).

Goes through UserService. Prints the user id and the role only: never the password or its hash.
"""

import argparse
import asyncio
import getpass
import os
import sys
from collections.abc import Callable, Mapping, Sequence
from contextlib import AbstractAsyncContextManager
from dataclasses import dataclass, field
from typing import Final, NoReturn, TextIO

from pydantic import TypeAdapter, ValidationError
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import PASSWORD_MAX_LENGTH, Settings, get_settings
from app.db import create_engine, create_session_factory
from app.modules.auth import security
from app.modules.auth.schemas import NormalizedEmail
from app.modules.users.service import UserService
from app.modules.users.types import UserRole

STAFF_ROLES: Final = {"admin": UserRole.ADMIN, "agent": UserRole.AGENT}
# Promotion only goes up: a customer or pro may become staff, an agent may become admin.
_RANK: Final = {UserRole.CUSTOMER: 0, UserRole.PRO: 0, UserRole.AGENT: 1, UserRole.ADMIN: 2}
STAFF_LOCALE: Final = "en"
_EMAIL: Final = TypeAdapter(NormalizedEmail)

SessionFactory = Callable[[], AbstractAsyncContextManager[AsyncSession]]


class StaffUserError(Exception):
    """A refusal with a message for the operator. The message never holds a secret."""


@dataclass
class Io:
    """The terminal, replaceable in tests."""

    prompt: Callable[[str], str] = input
    secret: Callable[[str], str] = getpass.getpass
    environ: Mapping[str, str] = field(default_factory=lambda: os.environ)
    out: TextIO = field(default_factory=lambda: sys.stdout)


class _Parser(argparse.ArgumentParser):
    def error(self, message: str) -> NoReturn:
        # argparse echoes unknown arguments; one of them could be a password typed by mistake.
        if message.startswith("unrecognized arguments"):
            message = "unrecognized arguments (not shown: one could be a password)"
        super().error(message)


def parse_args(argv: Sequence[str]) -> argparse.Namespace:
    parser = _Parser(
        prog="python -m scripts.create_staff_user",
        description="Create a staff account (admin or agent), or promote an existing one.",
        # No abbreviations: "--password" must not silently mean "--password-env".
        allow_abbrev=False,
    )
    parser.add_argument("--email", help="Asked for when omitted (interactive).")
    parser.add_argument("--role", choices=sorted(STAFF_ROLES), help="Asked for when omitted.")
    parser.add_argument(
        "--password-env",
        metavar="NAME",
        help="Non-interactive: read the password from this environment variable. Needs "
        "--email and --role.",
    )
    parser.add_argument(
        "--promote", action="store_true", help="Change the role of an existing account."
    )
    parser.add_argument("--yes", action="store_true", help="Non-interactive: confirm a promotion.")
    args = parser.parse_args(argv)
    if args.password_env is not None and (args.email is None or args.role is None):
        parser.error("--password-env needs --email and --role")
    if args.yes and args.password_env is None:
        parser.error("--yes is for non-interactive mode (--password-env); confirm at the prompt")
    return args


async def run(argv: Sequence[str], sessions: SessionFactory, settings: Settings, io: Io) -> int:
    """0 when the account is ready, 1 on a refusal (printed). Raises SystemExit on bad flags."""
    args = parse_args(argv)
    interactive = args.password_env is None
    try:
        email = _email(args.email if args.email is not None else io.prompt("Email: "))
        role = _role(args.role if args.role is not None else io.prompt("Role (admin, agent): "))
        async with sessions() as session:
            users = UserService(session)
            existing = await users.get_credentials_by_email(email)
            if existing is None:
                password = _password(args, io, settings)
                password_hash = await asyncio.to_thread(security.hash_password, password)
                account = await users.create_user(
                    email=email, password_hash=password_hash, role=role, locale=STAFF_LOCALE
                )
                await session.commit()
                print(f"Created user {account.id} with role {role.value}.", file=io.out)
                return 0
            account = existing.account
            if not args.promote:
                raise StaffUserError(
                    f"An account with this email already exists (user {account.id}, role "
                    f"{account.role.value}). Pass --promote to make it {role.value}."
                )
            if account.role is role:
                print(f"User {account.id} already has role {role.value}.", file=io.out)
                return 0
            if _RANK[account.role] > _RANK[role]:
                raise StaffUserError(
                    f"Refusing to demote user {account.id} from {account.role.value} to "
                    f"{role.value}."
                )
            print(
                f"Will change user {account.id} from {account.role.value} to {role.value}. "
                "The password does not change.",
                file=io.out,
            )
            if not _confirmed(args, io, interactive):
                raise StaffUserError("Not confirmed; nothing changed.")
            await users.set_role(account.id, role)
            await session.commit()
            print(f"User {account.id} now has role {role.value}.", file=io.out)
            return 0
    except StaffUserError as refusal:
        print(f"Error: {refusal}", file=io.out)
        return 1


def _email(raw: str) -> str:
    try:
        return _EMAIL.validate_python(raw)
    except ValidationError:
        raise StaffUserError("That is not a valid email address.") from None


def _role(raw: str) -> UserRole:
    role = STAFF_ROLES.get(raw.strip().lower())
    if role is None:
        raise StaffUserError(f"The role must be one of: {', '.join(sorted(STAFF_ROLES))}.")
    return role


def _password(args: argparse.Namespace, io: Io, settings: Settings) -> str:
    if args.password_env is not None:
        password = io.environ.get(args.password_env, "")
        if not password:
            raise StaffUserError(f"The environment variable {args.password_env} is not set.")
    else:
        password = io.secret("Password: ")
        if io.secret("Repeat the password: ") != password:
            raise StaffUserError("The passwords do not match.")
    if not settings.password_min_length <= len(password) <= PASSWORD_MAX_LENGTH:
        raise StaffUserError(
            f"The password must have {settings.password_min_length} to {PASSWORD_MAX_LENGTH} "
            "characters."
        )
    return password


def _confirmed(args: argparse.Namespace, io: Io, interactive: bool) -> bool:
    if not interactive:
        return bool(args.yes)
    return io.prompt("Proceed? [y/N] ").strip().lower() in {"y", "yes"}


async def _main(argv: Sequence[str]) -> int:
    settings = get_settings()
    engine = create_engine(settings)
    try:
        return await run(argv, create_session_factory(engine), settings, Io())
    finally:
        await engine.dispose()


def main() -> None:
    sys.exit(asyncio.run(_main(sys.argv[1:])))


if __name__ == "__main__":
    main()
