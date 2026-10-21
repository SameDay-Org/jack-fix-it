import socket

import pytest
import uvicorn

from app import serve
from app.serve import dual_stack_socket
from tests.conftest import make_settings


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
    assert config.forwarded_allow_ips == "10.0.0.0/8,fd00::/8"
