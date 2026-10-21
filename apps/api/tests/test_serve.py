import asyncio
import socket

import httpx
import pytest
import uvicorn
from starlette.types import Receive, Scope, Send

from app import serve
from app.serve import dual_stack_socket, trusted_proxy_hosts
from tests.conftest import make_settings

# A documentation address (RFC 5737) standing in for a real client behind the proxy.
CLIENT_IP = "203.0.113.7"


def test_dual_stack_socket_accepts_ipv4_and_ipv6() -> None:
    with dual_stack_socket(0) as sock:
        port = sock.getsockname()[1]
        sock.listen()

        assert sock.getsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY) == 0
        for host in ("127.0.0.1", "::1"):
            with socket.create_connection((host, port), timeout=1):
                pass


def test_forwarded_allow_ips_reaches_uvicorn(monkeypatch: pytest.MonkeyPatch) -> None:
    configs: list[uvicorn.Config] = []

    class FakeServer:
        def __init__(self, config: uvicorn.Config) -> None:
            configs.append(config)

        def run(self, sockets: list[socket.socket] | None = None) -> None:
            pass

    settings = make_settings(host="127.0.0.1", forwarded_allow_ips="10.0.0.0/8,fd00::/8")
    monkeypatch.setattr(serve, "get_settings", lambda: settings)
    monkeypatch.setattr(uvicorn, "Server", FakeServer)

    serve.main()

    [config] = configs
    assert config.forwarded_allow_ips == "10.0.0.0/8,fd00::/8,::ffff:10.0.0.0/104"


@pytest.mark.parametrize(
    ("configured", "expected"),
    [
        ("127.0.0.1", "127.0.0.1,::ffff:127.0.0.1/128"),
        (" 10.0.0.0/8 , fd00::/8 ", "10.0.0.0/8,fd00::/8,::ffff:10.0.0.0/104"),
        ("*", "*"),
        # Left as uvicorn reads them: a literal (unix socket) and a non-strict network.
        ("unix:/tmp/api.sock,10.0.0.1/8", "unix:/tmp/api.sock,10.0.0.1/8"),
    ],
)
def test_trusted_proxy_hosts_add_ipv4_mapped_forms(configured: str, expected: str) -> None:
    assert trusted_proxy_hosts(configured) == expected


async def echo_client(scope: Scope, receive: Receive, send: Send) -> None:
    """Answers with the client address uvicorn resolved."""
    assert scope["type"] == "http"
    host = scope["client"][0] if scope["client"] else ""
    await send({"type": "http.response.start", "status": 200, "headers": []})
    await send({"type": "http.response.body", "body": host.encode()})


async def test_proxy_over_ipv4_on_dual_stack_socket_is_trusted() -> None:
    # The default listener: an IPv4 proxy arrives as ::ffff:127.0.0.1 and must still match
    # FORWARDED_ALLOW_IPS=127.0.0.1, or every client would share the proxy's address.
    config = serve.build_config(make_settings(host="::", forwarded_allow_ips="127.0.0.1"))
    config.app = echo_client
    config.factory = False
    config.lifespan = "off"
    server = uvicorn.Server(config)
    sock = dual_stack_socket(0)
    port = sock.getsockname()[1]
    # Listening already: the kernel queues the requests until uvicorn starts accepting.
    sock.listen()
    task = asyncio.create_task(server.serve(sockets=[sock]))
    try:
        async with httpx.AsyncClient(timeout=5) as client:
            forwarded = await client.get(
                f"http://127.0.0.1:{port}/", headers={"X-Forwarded-For": CLIENT_IP}
            )
            direct = await client.get(f"http://127.0.0.1:{port}/")
    finally:
        server.should_exit = True
        await task
        sock.close()

    assert forwarded.text == CLIENT_IP
    assert direct.text == "::ffff:127.0.0.1"
