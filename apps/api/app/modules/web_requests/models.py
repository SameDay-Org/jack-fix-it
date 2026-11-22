import uuid
from datetime import datetime
from typing import Final

from sqlalchemy import CheckConstraint, DateTime, ForeignKey, String, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base

# The longest consent version id the web sends (e.g. "web-request-2026-11-20").
CONSENT_VERSION_MAX_LENGTH: Final = 64
# The idempotency key's unique index: a race of two creates with one key meets here.
IDEMPOTENCY_KEY_UNIQUE: Final = "uq_web_request_contacts_idempotency_key"


class WebRequestContact(Base):
    """Who to call about a request made on the web without an account (#86), staff only.

    The request's customer is a guest (users: status guest), which holds no contact: the first
    name, email and phone live here only, with the consent the visitor gave (the version of
    the words they saw, and when). Kept so a later sign-up with the same verified email or
    phone can claim the request (post-MVP). Never in a customer's or pro's view, a log, Sentry
    or the audit log: the BDC card reads it (ops)."""

    __tablename__ = "web_request_contacts"
    __table_args__ = (CheckConstraint("email = lower(email)", name="email_lowercase"),)

    request_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("service_requests.id"), primary_key=True
    )
    first_name: Mapped[str] = mapped_column(String(60))
    email: Mapped[str] = mapped_column(String(320))
    phone: Mapped[str] = mapped_column(String(20))
    consent_version: Mapped[str] = mapped_column(String(CONSENT_VERSION_MAX_LENGTH))
    consented_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    # The web service's Idempotency-Key: one request per key, whoever's (a guest is new each
    # time, so the key cannot be scoped to a customer as the app's is).
    idempotency_key: Mapped[uuid.UUID] = mapped_column(unique=True)
    idempotency_fingerprint: Mapped[str] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
