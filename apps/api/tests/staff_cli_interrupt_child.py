"""The child process of tests/test_staff_cli_interrupt.py (Gatekeeper round 4 B3, #58).

`python -m tests.staff_cli_interrupt_child <payment|payout> <rollback|prompt> <ids.json>`,
with the database URL in STAFF_CLI_INTERRUPT_DATABASE_URL (a fresh database the test owns).
Commits an admin and a lost payment or an unlinked pro profile, writes the entity's id and
stored state to <ids.json>, then runs the CLI's real `main()` with the production engine
(hide_parameters=True) and a fake Stripe, and presses Ctrl-C (a real SIGINT to this process):
- rollback: PostgreSQL refuses every audit_log insert (--yes); when the session rolls the
  refused insert back, SIGINT, and the rollback waits until it is cancelled.
- prompt: at "Proceed? [y/N]", SIGINT, and the prompt never answers (an operator who walked
  away from a terminal still open).
Not collected by pytest (no test_ prefix).
"""

import _thread
import asyncio
import json
import os
import signal
import sys
import threading
import uuid
from pathlib import Path

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings
from app.db import create_engine, create_session_factory
from app.integrations.stripe_connect import StripeExpressConnect
from app.integrations.stripe_payments import StripePaymentsClient
from scripts import resolve_payment_intent as payment_cli
from scripts import resolve_payout_account as payout_cli
from tests.audit_helpers import OPERATOR_EMAIL, make_staff
from tests.conftest import make_settings
from tests.test_opportunities_api import build_world
from tests.test_payouts_onboarding_api import FakeStripe
from tests.test_resolve_payment_intent import lost_payment, stripe_with
from tests.test_resolve_payment_intent import stored as stored_payment
from tests.test_resolve_payout_account import make_profile
from tests.test_resolve_payout_account import stored as stored_profile

# Sentinels the parent looks for in the output. A synthetic reason quoting an email: the
# refused row's DETAIL repeats it.
REASON = "interrupt-sentinel-note person-sigint@example.invalid"
ACCOUNT = "acct_sigintSentinel0fixture"


async def prepare(
    settings: Settings, domain: str, *, refuse_audits: bool
) -> tuple[object, list[str], dict[str, object]]:
    engine = create_engine(settings)
    assert engine.sync_engine.hide_parameters is True
    try:
        async with create_session_factory(engine)() as session:
            await make_staff(session)
            provider: object
            entity: uuid.UUID
            if domain == "payment":
                lost = await lost_payment(session, await build_world(session))
                provider, entity = stripe_with(lost.facts), lost.payment_id
                args = ["--payment", str(entity), "--adopt", lost.facts.payment_intent_id]
                before = await stored_payment(session, entity)
            else:
                entity = await make_profile(session)
                provider = FakeStripe(profiles={ACCOUNT: str(entity)})
                args = ["--pro", str(entity), "--adopt", ACCOUNT]
                before = await stored_profile(session, entity)
            if refuse_audits:
                # A real PostgreSQL refusal of the audit insert; NOT VALID spares existing rows.
                await session.execute(
                    text("ALTER TABLE audit_log ADD CONSTRAINT refuse_all CHECK (false) NOT VALID")
                )
                await session.commit()
    finally:
        await engine.dispose()
    ids: dict[str, object] = {
        "entity": str(entity),
        "before": [None if v is None else str(v) for v in before],
    }
    return provider, args, ids


def main() -> None:
    domain, point, ids_path = sys.argv[1:]
    settings = make_settings(
        database_url=os.environ["STAFF_CLI_INTERRUPT_DATABASE_URL"],
        stripe_secret_key="sk_test_fixture-not-a-real-key",
    )
    at_rollback = point == "rollback"
    provider, args, ids = asyncio.run(prepare(settings, domain, refuse_audits=at_rollback))
    Path(ids_path).write_text(json.dumps(ids), encoding="utf-8")

    # Outside pytest, its MonkeyPatch only stands in for typed attribute patches.
    patch = pytest.MonkeyPatch()
    cli = payment_cli if domain == "payment" else payout_cli
    patch.setattr(cli, "get_settings", lambda: settings)  # the fresh test database
    client = StripePaymentsClient if domain == "payment" else StripeExpressConnect
    patch.setattr(client, "from_settings", lambda _settings: provider)  # fake Stripe

    sys.argv = ["staff-cli", *args, "--operator", OPERATOR_EMAIL, "--reason", REASON]
    if not at_rollback:
        terminal = cli.Io

        def ctrl_c_at_the_prompt(_text: str) -> str:
            _thread.interrupt_main(signal.SIGINT)
            threading.Event().wait()  # no answer, ever
            return "y"

        patch.setattr(cli, "Io", lambda: terminal(prompt=ctrl_c_at_the_prompt))
        cli.main()
        return

    original_rollback = AsyncSession.rollback
    interrupted = False

    async def interrupted_rollback(self: AsyncSession) -> None:
        nonlocal interrupted
        # The failed audit flush left the transaction inactive: its rollback is pending.
        if not self.is_active and not interrupted:
            interrupted = True
            signal.raise_signal(signal.SIGINT)
            await asyncio.Event().wait()  # until Ctrl-C cancels the run
        await original_rollback(self)

    patch.setattr(AsyncSession, "rollback", interrupted_rollback)  # the Ctrl-C point

    sys.argv.append("--yes")
    cli.main()


if __name__ == "__main__":
    main()
