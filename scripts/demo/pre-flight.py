"""The demo's pre-flight: a green/red checklist to read before recording (docs/demo-video.md).

    cd apps/api
    uv run python ../../scripts/demo/pre-flight.py [--api URL] [--web URL]

It reads the same settings as the API (apps/api/.env) and looks at what a take needs: the
demo database and its seed, the API and the worker actually running on it, the demo accounts
signing in, Stripe in TEST mode, the served ZIP of the demo address, Mapbox, the storage and
the web panel. It changes nothing but one `ping` job it hands the worker.

It prints names and states only: never a key, a token, a password, or a URL that could hold
one. Exit 0 when nothing is red.
"""

import argparse
import asyncio
import os
import socket
import sys
import uuid
from collections.abc import Sequence
from dataclasses import dataclass
from enum import StrEnum
from pathlib import Path
from typing import Final
from urllib.parse import urlsplit

DEMO_DIR: Final = Path(__file__).resolve().parent
API_DIR: Final = DEMO_DIR.parents[1] / "apps" / "api"
# The API's own packages (`app`), and the settings' .env, live in apps/api.
sys.path.insert(0, str(API_DIR))
# Where the command was typed: a relative --password-file is read from there.
INVOKED_FROM: Final = Path.cwd()
if __name__ == "__main__":
    # The settings read apps/api/.env from the current directory, and app.worker (imported
    # below) loads them as it is imported: the directory changes before that.
    os.chdir(API_DIR)

import httpx  # noqa: E402
import stripe  # noqa: E402
from arq import create_pool  # noqa: E402
from arq.jobs import Job, JobStatus  # noqa: E402
from redis.exceptions import RedisError  # noqa: E402
from sqlalchemy import text  # noqa: E402
from sqlalchemy.exc import SQLAlchemyError  # noqa: E402

from app.config import Settings, get_settings, is_publishable_key  # noqa: E402
from app.db import create_engine  # noqa: E402
from app.worker import WorkerSettings  # noqa: E402
from demo_seed import cast, guard  # noqa: E402
from demo_seed.bucket import BucketState, bucket_state  # noqa: E402
from demo_seed.scenes import MARKER_KEY  # noqa: E402
from demo_seed.stripe_standins import is_stand_in  # noqa: E402

HTTP_TIMEOUT_SECONDS: Final = 5.0
# How long the worker has to take the ping job off the queue.
WORKER_WAIT_SECONDS: Final = 8.0
REQUIRED_CATEGORIES: Final = frozenset(
    {"handyman", "painting", "house-cleaning", "lawn-landscaping", "moving-assembly"}
)
_COLOURS: Final = {"ok": "\033[32m", "warn": "\033[33m", "fail": "\033[31m"}
_RESET: Final = "\033[0m"


class State(StrEnum):
    OK = "ok"
    WARN = "warn"
    FAIL = "fail"


@dataclass(frozen=True)
class Check:
    state: State
    what: str
    detail: str = ""


def ok(what: str, detail: str = "") -> Check:
    return Check(State.OK, what, detail)


def warn(what: str, detail: str) -> Check:
    return Check(State.WARN, what, detail)


def fail(what: str, detail: str) -> Check:
    return Check(State.FAIL, what, detail)


def parse_args(argv: Sequence[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog="pre-flight.py",
        description="Check the demo stack before recording. Changes nothing.",
        allow_abbrev=False,
    )
    parser.add_argument("--api", help="The running API (default: http://127.0.0.1:<PORT>).")
    parser.add_argument("--web", default="http://localhost:3000", help="The running web app.")
    parser.add_argument(
        "--password-file",
        type=Path,
        default=DEMO_DIR / ".demo-password",
        help="Where seed_demo.py kept the demo password.",
    )
    return parser.parse_args(argv)


# ---- The database and its seed ----


async def check_seed(settings: Settings) -> list[Check]:
    """The demo database is seeded, and its open dispute can be refunded."""
    engine = create_engine(settings)
    try:
        async with engine.connect() as connection:
            marker = (
                await connection.execute(
                    text("SELECT value FROM settings WHERE key = :key"), {"key": MARKER_KEY}
                )
            ).scalar_one_or_none()
            if not isinstance(marker, dict):
                return [fail("Demo data", "not seeded: run seed_demo.py --reset")]
            checks = [ok("Demo data", f"seeded, {marker.get('requests')} requests of history")]
            intent = (
                await connection.execute(
                    text(
                        "SELECT p.stripe_payment_intent_id FROM payments p JOIN service_requests r"
                        " ON r.id = p.request_id JOIN jobs j ON j.request_id = r.id JOIN disputes"
                        " d ON d.job_id = j.id WHERE d.status = 'open' AND r.public_code = :code"
                    ),
                    {"code": marker.get("dispute_code")},
                )
            ).scalar_one_or_none()
            if intent is None:
                checks.append(
                    warn("Open dispute", "none (resolved already?): reseed before the next take")
                )
            elif is_stand_in(intent):
                checks.append(
                    fail("Open dispute", "paid through a stand-in: the panel cannot refund it")
                )
            else:
                checks.append(ok("Open dispute", f"{marker.get('dispute_code')}, a Stripe payment"))
            fresh = (
                await connection.execute(
                    text(
                        "SELECT count(*) FROM service_requests WHERE status = 'received' AND "
                        "assigned_agent_id IS NULL AND first_contact_at IS NULL AND created_at > "
                        "now() - make_interval(mins => :sla)"
                    ),
                    {"sla": settings.ops_first_contact_sla_minutes},
                )
            ).scalar_one()
            checks.append(
                ok("Queue, New tab", f"{fresh} fresh request(s)")
                if fresh
                else warn("Queue, New tab", "empty (they turned urgent): seed_demo.py --fresh")
            )
            devices = (await connection.execute(text("SELECT count(*) FROM devices"))).scalar_one()
            checks.append(
                ok("Push", "no device registered: nothing leaves")
                if not devices
                else warn(
                    "Push", f"{devices} device(s) registered: they will get the demo's pushes"
                )
            )
            return checks
    except (SQLAlchemyError, OSError):
        return [fail("Demo database", "not reachable, or not migrated: run seed_demo.py --reset")]
    finally:
        await engine.dispose()


# ---- The running stack ----


def _port_note(url: str) -> str:
    """Whether something else holds the port of a service that did not answer."""
    parts = urlsplit(url)
    port = parts.port or (443 if parts.scheme == "https" else 80)
    try:
        with socket.create_connection((parts.hostname or "localhost", port), timeout=1):
            return f"port {port} is taken, but not by it"
    except OSError:
        return f"nothing listens on port {port}: start it"


async def check_api(http: httpx.AsyncClient, api: str) -> list[Check]:
    try:
        alive = await http.get(f"{api}/health")
        ready = await http.get(f"{api}/health/ready")
    except httpx.HTTPError:
        return [fail("API", _port_note(api))]
    if alive.status_code != httpx.codes.OK:
        return [fail("API", f"/health answered {alive.status_code}")]
    if ready.status_code != httpx.codes.OK:
        return [ok("API", "up"), fail("API dependencies", "Postgres or Redis is not ready")]
    return [ok("API", "up, Postgres and Redis ready")]


async def check_accounts(http: httpx.AsyncClient, api: str, password: str | None) -> list[Check]:
    """Each demo account signs in to the running API: it is on the seeded database, and the
    password file is the right one."""
    if password is None:
        return [fail("Demo password", "no password file: run seed_demo.py --reset")]
    checks: list[Check] = []
    for label, email, expected in (
        ("Admin", cast.ADMIN_EMAIL, "admin"),
        ("Agent", cast.AGENT_EMAIL, "agent"),
        ("Jamie", cast.JAMIE.email, "customer"),
        ("Dan", cast.DAN.email, "pro"),
        ("Maria", cast.MARIA.email, "pro"),
    ):
        try:
            answer = await http.post(
                f"{api}/v1/auth/login", json={"email": email, "password": password}
            )
        except httpx.HTTPError:
            return [*checks, fail(f"{label} signs in", "the API did not answer")]
        if answer.status_code == httpx.codes.TOO_MANY_REQUESTS:
            checks.append(warn(f"{label} signs in", "rate limited: wait a minute, run again"))
            continue
        if answer.status_code != httpx.codes.OK:
            checks.append(
                fail(f"{label} signs in", "refused: is the API on the seeded demo database?")
            )
            continue
        body = answer.json()
        user = body["user"]
        detail = f"{user['role']}, locale {user['locale']}"
        staff = expected in ("admin", "agent")
        if user["role"] != expected or (staff and user["locale"] != "en"):
            checks.append(fail(f"{label} signs in", detail))
            continue
        if expected == "pro":
            detail = await _pro_state(http, api, body["access_token"])
            wanted = "approved, payouts on" if email == cast.DAN.email else "pending, payouts off"
            checks.append((ok if detail == wanted else fail)(f"{label} signs in", detail))
            continue
        checks.append(ok(f"{label} signs in", detail))
    return checks


async def _pro_state(http: httpx.AsyncClient, api: str, token: str) -> str:
    answer = await http.get(f"{api}/v1/pros/me", headers={"Authorization": f"Bearer {token}"})
    if answer.status_code != httpx.codes.OK:
        return f"profile answered {answer.status_code}"
    profile = answer.json()
    payouts = "on" if profile["payouts_enabled"] else "off"
    return f"{profile['verification_status']}, payouts {payouts}"


async def check_catalog(http: httpx.AsyncClient, api: str) -> list[Check]:
    """The demo address is in a served ZIP, and the categories the storyboard names exist."""
    zip_code = cast.JAMIE_HOME.zip_code
    try:
        served = await http.get(f"{api}/v1/service-areas/check", params={"zip": zip_code})
        categories = await http.get(f"{api}/v1/categories")
    except httpx.HTTPError:
        return [fail("Catalog", "the API did not answer")]
    checks: list[Check] = []
    if served.status_code == httpx.codes.OK and served.json()["served"]:
        checks.append(ok("Demo address", f"ZIP {zip_code} is served"))
    else:
        checks.append(fail("Demo address", f"ZIP {zip_code} is not served: seed the service areas"))
    slugs = {item["slug"] for item in categories.json()} if categories.is_success else set()
    missing = sorted(REQUIRED_CATEGORIES - slugs)
    checks.append(
        ok("Categories", f"{len(slugs)} active")
        if not missing
        else fail("Categories", f"missing: {', '.join(missing)}")
    )
    return checks


async def check_worker() -> Check:
    """A worker takes a `ping` job off the queue: one is running on REDIS_URL's Redis. It
    cannot tell which database that worker writes: start the worker from the same .env."""
    try:
        pool = await create_pool(WorkerSettings.redis_settings)
    except (RedisError, OSError):
        return fail("Worker", "Redis (REDIS_URL) is not reachable")
    try:
        job_id = f"demo-preflight:{uuid.uuid4().hex}"
        await pool.enqueue_job("ping", _job_id=job_id)
        job = Job(job_id, pool)
        waited = 0.0
        while waited < WORKER_WAIT_SECONDS:
            if await job.status() is not JobStatus.queued:
                return ok("Worker", "one on this Redis took the ping job")
            await asyncio.sleep(0.25)
            waited += 0.25
        return fail("Worker", "no worker took the ping job: start it (arq app.worker...)")
    except (RedisError, OSError):
        return fail("Worker", "Redis failed while the ping waited")
    finally:
        await pool.aclose()


async def check_stripe(settings: Settings) -> list[Check]:
    """TEST keys, checked by their prefixes and by one read of the account's balance. No key
    is printed, and no Stripe answer either."""
    key = settings.stripe_secret_key
    if key is None:
        return [fail("Stripe secret key", "STRIPE_SECRET_KEY is not set")]
    if not key.get_secret_value().startswith(guard.STRIPE_TEST_PREFIX):
        return [fail("Stripe secret key", "not a TEST key: never record with a live one")]
    checks: list[Check] = []
    try:
        client = stripe.StripeClient(
            key.get_secret_value(), http_client=stripe.HTTPXClient(timeout=HTTP_TIMEOUT_SECONDS)
        )
        balance = await client.v1.balance.retrieve_async()
        checks.append(
            fail("Stripe secret key", "Stripe says live mode")
            if balance.livemode
            else ok("Stripe secret key", "a TEST key, and Stripe accepts it")
        )
    except stripe.StripeError:
        checks.append(fail("Stripe secret key", "a TEST key, but Stripe refused the call"))
    publishable = settings.stripe_publishable_key
    if publishable is None or not is_publishable_key(publishable):
        checks.append(fail("Stripe publishable key", "STRIPE_PUBLISHABLE_KEY is not set"))
    elif not publishable.startswith("pk_test_"):
        checks.append(fail("Stripe publishable key", "not a TEST key"))
    else:
        checks.append(ok("Stripe publishable key", "a TEST key"))
    checks.append(
        ok("Stripe webhook secret", "set (keep `stripe listen` forwarding while recording)")
        if settings.stripe_webhook_secret is not None
        else fail("Stripe webhook secret", "STRIPE_WEBHOOK_SECRET is not set: no payment books")
    )
    checks.append(
        ok("Stripe Connect webhook secret", "set")
        if settings.stripe_connect_webhook_secret is not None
        else warn(
            "Stripe Connect webhook secret",
            "not set: the pro's payouts turn on only when the app reads the status",
        )
    )
    checks.append(
        ok("Public API URL", "set (Stripe's onboarding returns to it)")
        if settings.public_api_url is not None
        else fail("Public API URL", "PUBLIC_API_URL is not set: no onboarding link")
    )
    return checks


def check_settings(settings: Settings) -> list[Check]:
    """What the API's own settings say: Mapbox for the live map, the storage for the files."""
    checks = [
        ok("Mapbox token (API)", "set: routes and the live map answer")
        if settings.mapbox_access_token is not None
        else fail("Mapbox token (API)", "MAPBOX_ACCESS_TOKEN is not set: the route answers 503")
    ]
    storage = bucket_state(settings)
    checks.append(
        ok("Storage", "the uploads bucket answers")
        if storage is BucketState.READY
        else fail("Storage", f"S3 bucket {storage.value.replace('_', ' ')}")
    )
    return checks


async def check_web(http: httpx.AsyncClient, web: str) -> Check:
    try:
        login = await http.get(f"{web}/admin/login")
        landing = await http.get(f"{web}/")
    except httpx.HTTPError:
        return fail("Web app", _port_note(web))
    if login.status_code != httpx.codes.OK or landing.status_code != httpx.codes.OK:
        return fail("Web app", f"/admin/login {login.status_code}, / {landing.status_code}")
    return ok("Web app", "the panel's sign-in and the landing answer")


# ---- The checklist ----


async def run(settings: Settings, args: argparse.Namespace) -> list[Check]:
    try:
        guard.check_settings(settings)
    except guard.DemoGuardError as refusal:
        # Nothing else is looked at: this is not a demo environment.
        return [fail("Demo database", str(refusal))]
    checks = [ok("Demo database", "local, named jackdemo*")]
    api = args.api or f"http://127.0.0.1:{settings.port}"
    password = None
    if args.password_file.exists():
        password = args.password_file.read_text(encoding="utf-8").strip()
    checks += await check_seed(settings)
    async with httpx.AsyncClient(timeout=HTTP_TIMEOUT_SECONDS, follow_redirects=True) as http:
        api_checks = await check_api(http, api)
        checks += api_checks
        if api_checks[0].state is State.OK:
            checks += await check_accounts(http, api, password)
            checks += await check_catalog(http, api)
        checks.append(await check_worker())
        checks += await check_stripe(settings)
        checks += check_settings(settings)
        checks.append(await check_web(http, args.web))
    return checks


def render(checks: Sequence[Check], *, colour: bool) -> str:
    lines = []
    for check in checks:
        tag = f"[{check.state.value.upper():^4}]"
        if colour:
            tag = f"{_COLOURS[check.state.value]}{tag}{_RESET}"
        lines.append(f"{tag} {check.what}{': ' + check.detail if check.detail else ''}")
    red = sum(check.state is State.FAIL for check in checks)
    yellow = sum(check.state is State.WARN for check in checks)
    lines.append("")
    lines.append(
        f"{red} red, {yellow} yellow. "
        + ("Ready to record." if not red else "Fix the red lines before recording.")
    )
    lines.append(
        "By eye (docs/demo-video.md): emulator in English at font 1.0, the dev client's gear "
        "hidden, the dev build's Mapbox token and EXPO_PUBLIC_PRO_LOCATION_SHARING=on, no "
        "personal data on screen."
    )
    return "\n".join(lines)


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(sys.argv[1:] if argv is None else argv)
    args.password_file = INVOKED_FROM / args.password_file
    checks = asyncio.run(run(get_settings(), args))
    print(render(checks, colour=sys.stdout.isatty()))
    return 1 if any(check.state is State.FAIL for check in checks) else 0


if __name__ == "__main__":
    raise SystemExit(main())
