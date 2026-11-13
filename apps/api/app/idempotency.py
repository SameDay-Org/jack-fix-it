"""Idempotency-Key helpers for the creates that take one: service requests (#264) and support
tickets (#380).

A create stores its key with a fingerprint of the body it came with. A repeat of the key
within the window answers what the first call made; the same key with another body is
refused. The fingerprint is a hash: the body's free text is never kept a second time in clear.
"""

import hashlib
import hmac
import json

from pydantic import BaseModel


def body_fingerprint(data: BaseModel) -> str:
    """SHA-256 (hex) of the body as validated (trimmed, defaults filled in), its keys sorted:
    two bodies that differ in any field differ here, and the same body is the same however
    its JSON was laid out.

    Raises UnicodeEncodeError for text with no UTF-8 form (a lone surrogate the schema let
    through). The caller answers it as the validation error a create without a key answers,
    before it looks the key up, so the key stays unused."""
    canonical = json.dumps(
        data.model_dump(mode="json"), sort_keys=True, separators=(",", ":"), ensure_ascii=False
    )
    return hashlib.sha256(canonical.encode()).hexdigest()


def same_body(stored: str | None, fingerprint: str) -> bool:
    """Whether a stored fingerprint is this body's, compared in constant time."""
    return hmac.compare_digest(stored or "", fingerprint)
