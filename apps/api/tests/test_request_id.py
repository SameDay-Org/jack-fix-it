import json
import logging

import httpx
import pytest

from app.middleware import REQUEST_ID_HEADER
from app.observability import JsonFormatter


async def test_generates_a_request_id_when_none_is_sent(client: httpx.AsyncClient) -> None:
    response = await client.get("/health")

    request_id = response.headers[REQUEST_ID_HEADER]
    assert len(request_id) == 32
    assert request_id.isalnum()


async def test_propagates_a_valid_incoming_request_id(client: httpx.AsyncClient) -> None:
    response = await client.get("/health", headers={REQUEST_ID_HEADER: "edge-abc.123:4"})

    assert response.headers[REQUEST_ID_HEADER] == "edge-abc.123:4"


@pytest.mark.parametrize("unsafe_id", ["x" * 129, "has space", 'quote"inside', "new\\nline"])
async def test_replaces_an_unsafe_incoming_request_id(
    client: httpx.AsyncClient, unsafe_id: str
) -> None:
    response = await client.get("/health", headers={REQUEST_ID_HEADER: unsafe_id})

    assert response.headers[REQUEST_ID_HEADER] != unsafe_id
    assert len(response.headers[REQUEST_ID_HEADER]) == 32


async def test_access_log_carries_the_request_id_and_no_query_string(
    client: httpx.AsyncClient, caplog: pytest.LogCaptureFixture
) -> None:
    with caplog.at_level(logging.INFO, logger="app.access"):
        await client.get(
            "/health?email=someone@example.com", headers={REQUEST_ID_HEADER: "trace-1"}
        )

    [record] = [r for r in caplog.records if r.name == "app.access"]
    line = json.loads(JsonFormatter().format(record))
    assert line["message"] == "request"
    assert line["request_id"] == "trace-1"
    assert line["path"] == "/health"
    assert line["status"] == 200
    assert "someone@example.com" not in json.dumps(line)
