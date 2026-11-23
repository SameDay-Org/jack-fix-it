"""The demo's API with a stand-in SMS verifier (Relay's N3, #568).

The local stack has no Twilio Verify (its TEST credentials do not reach the Verify API), so a
sign-up's phone step (storyboard scenes 2 and 4) never gets a code. This runs the real app, as
`python -m app.serve` does, with one change: the phone verifier sends nothing and accepts
DEMO_SMS_CODE (default 123456) for any number.

It runs only where the seed may: the same guard refuses anything but a local `jackdemo`
database, a deployed APP_ENV, a Stripe key that is not a TEST key or a storage elsewhere.

Run it instead of `python -m app.serve`, from apps/api, on the seed's .env:

    uv run python ../../scripts/demo/demo_api.py
"""

import hmac
import os
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Final

DEMO_DIR: Final = Path(__file__).resolve().parent
API_DIR: Final = DEMO_DIR.parents[1] / "apps" / "api"
# The API's own packages live in apps/api, and the settings read its .env from there.
sys.path.insert(0, str(API_DIR))
if __name__ == "__main__":
    os.chdir(API_DIR)

import uvicorn  # noqa: E402

from app.config import get_settings  # noqa: E402
from app.main import create_app  # noqa: E402
from app.observability import configure_logging  # noqa: E402
from app.serve import DUAL_STACK_HOST, dual_stack_socket, trusted_proxy_hosts  # noqa: E402
from demo_seed import guard  # noqa: E402

DEFAULT_CODE: Final = "123456"


@dataclass(frozen=True)
class StandInVerifier:
    """app.integrations.sms_verify.PhoneVerifier for the demo: sends no SMS; `code` verifies
    any phone, compared in constant time."""

    code: str = field(repr=False)

    async def start(self, phone: str, locale: str | None) -> None:
        return None

    async def check(self, phone: str, code: str) -> bool:
        return hmac.compare_digest(code.encode(), self.code.encode())


def main() -> None:
    settings = get_settings()
    guard.check_settings(settings)
    configure_logging(settings.log_level)
    app = create_app(settings)
    app.state.phone_verifier = StandInVerifier(os.environ.get("DEMO_SMS_CODE", DEFAULT_CODE))
    config = uvicorn.Config(
        app,
        host=settings.host,
        port=settings.port,
        log_config=None,  # the JSON root handler, as app.serve keeps it
        access_log=False,
        forwarded_allow_ips=trusted_proxy_hosts(settings.forwarded_allow_ips),
    )
    server = uvicorn.Server(config)
    if settings.host == DUAL_STACK_HOST:
        server.run(sockets=[dual_stack_socket(settings.port)])
    else:
        server.run()


if __name__ == "__main__":
    main()
