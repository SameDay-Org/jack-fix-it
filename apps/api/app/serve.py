"""API process entrypoint: `python -m app.serve`.

HOST and PORT come from settings instead of a shell command line, so Railway needs no
`$PORT` expansion in the start command.
"""

import socket

import uvicorn

from app.config import get_settings
from app.observability import configure_logging

DUAL_STACK_HOST = "::"


def dual_stack_socket(port: int) -> socket.socket:
    """One socket for IPv6 and IPv4.

    asyncio makes a "::" listener IPv6-only. Railway's private network (web -> api) uses IPv6,
    while the public proxy and the healthcheck may connect over IPv4, so the API needs both.
    """
    sock = socket.socket(socket.AF_INET6, socket.SOCK_STREAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 0)
    sock.bind((DUAL_STACK_HOST, port))
    return sock


def main() -> None:
    settings = get_settings()
    configure_logging(settings.log_level)
    config = uvicorn.Config(
        "app.main:create_app",
        factory=True,
        host=settings.host,
        port=settings.port,
        log_config=None,  # keep the JSON root handler
        access_log=False,  # RequestIdMiddleware logs requests without query strings
    )
    server = uvicorn.Server(config)
    if settings.host == DUAL_STACK_HOST:
        server.run(sockets=[dual_stack_socket(settings.port)])
    else:
        server.run()


if __name__ == "__main__":
    main()
