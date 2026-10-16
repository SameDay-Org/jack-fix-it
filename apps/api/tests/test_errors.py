import httpx
import pytest
from fastapi import FastAPI
from pydantic import BaseModel

from app.errors import ConflictError, NotFoundError
from app.middleware import REQUEST_ID_HEADER


class Payload(BaseModel):
    amount_cents: int


@pytest.fixture
def app(app: FastAPI) -> FastAPI:
    """The default app plus throwaway routes that raise each kind of error."""

    @app.get("/test/not-found")
    async def not_found() -> None:
        raise NotFoundError

    @app.get("/test/conflict")
    async def conflict() -> None:
        raise ConflictError("Job is already completed.")

    @app.get("/test/crash")
    async def crash() -> None:
        raise RuntimeError("secret connection string postgres://user:pw@host")

    @app.post("/test/validate")
    async def validate(payload: Payload) -> Payload:
        return payload

    return app


async def test_app_error_uses_the_error_contract(client: httpx.AsyncClient) -> None:
    response = await client.get("/test/not-found")

    assert response.status_code == 404
    assert response.json() == {"error": {"code": "not_found", "message": "Resource not found."}}


async def test_app_error_can_carry_a_specific_message(client: httpx.AsyncClient) -> None:
    response = await client.get("/test/conflict")

    assert response.status_code == 409
    assert response.json() == {
        "error": {"code": "conflict", "message": "Job is already completed."}
    }


async def test_unknown_route_uses_the_error_contract(client: httpx.AsyncClient) -> None:
    response = await client.get("/does-not-exist")

    assert response.status_code == 404
    assert response.json() == {"error": {"code": "not_found", "message": "Not Found."}}


async def test_validation_error_uses_the_error_contract_without_echoing_input(
    client: httpx.AsyncClient,
) -> None:
    response = await client.post("/test/validate", json={"amount_cents": "secret-value"})

    assert response.status_code == 422
    assert response.json() == {
        "error": {"code": "validation_error", "message": "The request is invalid."}
    }


async def test_unexpected_error_returns_a_generic_500_that_leaks_nothing(
    client: httpx.AsyncClient,
) -> None:
    response = await client.get("/test/crash", headers={REQUEST_ID_HEADER: "crash-1"})

    assert response.status_code == 500
    assert response.json() == {
        "error": {"code": "internal_error", "message": "Internal server error."}
    }
    assert "postgres" not in response.text
    assert "RuntimeError" not in response.text
    assert response.headers[REQUEST_ID_HEADER] == "crash-1"
