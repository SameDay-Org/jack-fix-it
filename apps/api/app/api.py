"""Versioned public API. Include each domain router (app/modules/<domain>/router.py) here."""

from fastapi import APIRouter

from app.errors import ErrorResponse

# Documents the real 422 body (the error contract) instead of FastAPI's default schema.
v1_router = APIRouter(
    prefix="/v1",
    responses={422: {"model": ErrorResponse, "description": "The request is invalid."}},
)
