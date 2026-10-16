import socket

from app.serve import dual_stack_socket


def test_dual_stack_socket_accepts_ipv4_and_ipv6() -> None:
    with dual_stack_socket(0) as sock:
        port = sock.getsockname()[1]
        sock.listen()

        assert sock.getsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY) == 0
        for host in ("127.0.0.1", "::1"):
            with socket.create_connection((host, port), timeout=1):
                pass
