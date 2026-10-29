"""Versioned public API. Include each domain router (app/modules/<domain>/router.py) here."""

from fastapi import APIRouter

from app.errors import ErrorResponse
from app.modules.addresses.router import router as addresses_router
from app.modules.auth.router import router as auth_router
from app.modules.categories.router import router as categories_router
from app.modules.devices.router import router as devices_router
from app.modules.dispatch.router import router as opportunities_router
from app.modules.geo.router import router as geo_router
from app.modules.notifications.router import router as notification_preferences_router
from app.modules.pros.router import router as pros_router
from app.modules.quotes.router import customer_router as customer_quotes_router
from app.modules.quotes.router import router as quotes_router
from app.modules.requests.router import router as requests_router
from app.modules.service_areas.router import router as service_areas_router
from app.modules.uploads.router import router as uploads_router
from app.modules.waitlist.router import router as waitlist_router

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
v1_router.include_router(geo_router)
v1_router.include_router(pros_router)
v1_router.include_router(opportunities_router)
v1_router.include_router(quotes_router)
v1_router.include_router(customer_quotes_router)
v1_router.include_router(devices_router)
v1_router.include_router(waitlist_router)
v1_router.include_router(addresses_router)
v1_router.include_router(notification_preferences_router)
