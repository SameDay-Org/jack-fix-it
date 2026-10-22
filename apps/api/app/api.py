"""Versioned public API. Include each domain router (app/modules/<domain>/router.py) here."""

from fastapi import APIRouter

from app.errors import ErrorResponse
from app.modules.auth.router import router as auth_router
from app.modules.categories.router import router as categories_router
from app.modules.requests.router import router as requests_router
from app.modules.service_areas.router import router as service_areas_router
from app.modules.uploads.router import router as uploads_router

# Documents the real 422 body (the error contract) instead of FastAPI's default schema.
v1_router = APIRouter(
    prefix="/v1",
    responses={422: {"model": ErrorResponse, "description": "The request is invalid."}},
)
v1_router.include_router(auth_router)
v1_router.include_router(uploads_router)
v1_router.include_router(requests_router)
v1_router.include_router(categories_router)
v1_router.include_router(service_areas_router)
