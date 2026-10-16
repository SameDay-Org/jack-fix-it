"""Error contract: every error response body is {"error": {"code": ..., "message": ...}}.

Raise an AppError subclass for expected failures. Anything else becomes a generic 500 that
reveals nothing about the cause; the details go to the logs and Sentry.
"""

import logging
from collections.abc import Mapping
from http import HTTPStatus

from fastapi import FastAPI
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.requests import Request

from app.middleware import REQUEST_ID_HEADER

logger = logging.getLogger(__name__)


class ErrorDetail(BaseModel):
    code: str
    message: str


class ErrorResponse(BaseModel):
    error: ErrorDetail


class AppError(Exception):
    """Base for expected errors. Subclasses set the status, a stable code and a safe message."""

    status_code: int = 500
    code: str = "internal_error"
    message: str = "Internal server error."

    def __init__(self, message: str | None = None) -> None:
        self.message = message or type(self).message
        super().__init__(self.message)


class BadRequestError(AppError):
    status_code = 400
    code = "bad_request"
    message = "The request is invalid."


class UnauthorizedError(AppError):
    status_code = 401
    code = "unauthorized"
    message = "Authentication is required."


class ForbiddenError(AppError):
    status_code = 403
    code = "forbidden"
    message = "You do not have access to this resource."


class NotFoundError(AppError):
    status_code = 404
    code = "not_found"
    message = "Resource not found."


class ConflictError(AppError):
    status_code = 409
    code = "conflict"
    message = "The request conflicts with the current state."


def error_response(
    status_code: int,
    code: str,
    message: str,
    headers: Mapping[str, str] | None = None,
) -> JSONResponse:
    body = ErrorResponse(error=ErrorDetail(code=code, message=message))
    return JSONResponse(body.model_dump(), status_code=status_code, headers=headers)


async def _handle_app_error(_: Request, exc: Exception) -> JSONResponse:
    assert isinstance(exc, AppError)  # noqa: S101 - registered for AppError only
    return error_response(exc.status_code, exc.code, exc.message)


async def _handle_http_exception(_: Request, exc: Exception) -> JSONResponse:
    """Framework errors (unknown route, wrong method). The detail text is not echoed."""
    assert isinstance(exc, StarletteHTTPException)  # noqa: S101 - registered for it only
    try:
        phrase = HTTPStatus(exc.status_code).phrase
    except ValueError:
        phrase = "HTTP error"
    code = phrase.lower().replace(" ", "_")
    return error_response(exc.status_code, code, f"{phrase}.", headers=exc.headers)


async def _handle_validation_error(_: Request, __: Exception) -> JSONResponse:
    return error_response(422, "validation_error", "The request is invalid.")


async def _handle_unexpected_error(request: Request, exc: Exception) -> JSONResponse:
    # Runs in Starlette's outermost middleware, after RequestIdMiddleware has finished,
    # so the request id is read from the request state instead of the context var.
    request_id: str | None = getattr(request.state, "request_id", None)
    logger.error("unhandled_error", exc_info=exc, extra={"request_id": request_id})
    headers = {REQUEST_ID_HEADER: request_id} if request_id else None
    return error_response(500, AppError.code, AppError.message, headers=headers)


def register_error_handlers(app: FastAPI) -> None:
    app.add_exception_handler(AppError, _handle_app_error)
    app.add_exception_handler(StarletteHTTPException, _handle_http_exception)
    app.add_exception_handler(RequestValidationError, _handle_validation_error)
    app.add_exception_handler(Exception, _handle_unexpected_error)
