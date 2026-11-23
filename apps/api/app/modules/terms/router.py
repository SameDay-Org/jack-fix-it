from typing import Annotated, Any

from fastapi import APIRouter, Depends, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings, get_app_settings
from app.db import get_session
from app.errors import ErrorResponse
from app.middleware import NoStoreRoute
from app.modules.auth.dependencies import CurrentUser
from app.modules.terms.schemas import TermsAcceptanceIn, TermsDocumentOut, TermsOut
from app.modules.terms.service import TermsConfig, TermsDocument, TermsService

# The legal documents' acceptances (#97): the caller's own only.
router = APIRouter(prefix="/me", tags=["terms"], route_class=NoStoreRoute)


def _error(description: str) -> dict[str, Any]:
    return {"model": ErrorResponse, "description": description}


def get_terms_service(
    session: Annotated[AsyncSession, Depends(get_session)],
    settings: Annotated[Settings, Depends(get_app_settings)],
) -> TermsService:
    return TermsService(session, TermsConfig.from_settings(settings))


Terms = Annotated[TermsService, Depends(get_terms_service)]


def _out(document: TermsDocument) -> TermsDocumentOut:
    return TermsDocumentOut(
        kind=document.kind,
        version=document.version,
        accepted=document.accepted,
        accepted_at=document.accepted_at,
    )


@router.get(
    "/terms",
    response_model=TermsOut,
    summary="The legal documents I must accept",
    responses={status.HTTP_401_UNAUTHORIZED: _error("invalid_token: missing or expired.")},
)
async def get_my_terms(user: CurrentUser, terms: Terms) -> TermsOut:
    """The versions in force of the documents the caller's role accepts (terms and privacy;
    pros also the pro agreement), and whether the caller accepted each. The texts are the
    apps'; the API names each by its version id."""
    documents = await terms.documents(user)
    return TermsOut(
        terms_required=any(not document.accepted for document in documents),
        documents=[_out(document) for document in documents],
    )


@router.post(
    "/terms-acceptance",
    response_model=TermsDocumentOut,
    summary="Accept a legal document",
    responses={
        status.HTTP_401_UNAUTHORIZED: _error("invalid_token: missing or expired."),
        status.HTTP_409_CONFLICT: _error(
            "terms_not_current: not the version in force, a document the caller's role does "
            "not accept, or one with no version published."
        ),
        status.HTTP_422_UNPROCESSABLE_CONTENT: _error(
            "validation_error: an unknown kind, a version that is not an id, an extra field."
        ),
    },
)
async def accept_terms(
    data: TermsAcceptanceIn, user: CurrentUser, terms: Terms
) -> TermsDocumentOut:
    """Records that the caller accepted this version. Idempotent: accepting the same version
    again answers the same, with the time of the first acceptance."""
    return _out(await terms.accept(user, data.kind, data.version))
