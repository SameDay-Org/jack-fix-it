"""What the customer sees for a request: the glossary's i18n keys (Cesar, 2026-10-21).

docs/glossary.md "Customer-visible statuses" lists the keys. Once the request is paid, the
job's status takes over (app/modules/jobs/transitions.py CUSTOMER_STATUS).
"""

from collections.abc import Mapping
from types import MappingProxyType
from typing import Final

from app.modules.requests.models import RequestStatus

_S = RequestStatus

REQUEST_CUSTOMER_STATUS: Final[Mapping[RequestStatus, str]] = MappingProxyType(
    {
        _S.RECEIVED: "customerStatus.requestReceived",
        _S.REVIEWING: "customerStatus.reviewing",
        _S.FINDING_PRO: "customerStatus.findingAPro",
        _S.QUOTE_READY: "customerStatus.quoteReady",
        # Payment pending: still the quote screen until the job exists.
        _S.ACCEPTED: "customerStatus.quoteReady",
        _S.EXPIRED: "customerStatus.cancelled",
        _S.CANCELLED: "customerStatus.cancelled",
    }
)
