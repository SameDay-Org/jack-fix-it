"""The CA roots the API trusts on its outbound TLS calls (#96).

Every integration verifies against certifi's bundle: the httpx clients (Twilio Verify, Resend,
Expo push, geocoding, Mapbox) with the default `verify=True`, and botocore (S3). Railway sets
neither SSL_CERT_FILE nor SSL_CERT_DIR. Python's ssl module does not check revocation, so a
root whose intermediates leaked their keys is only safe once it is out of the bundle.
"""

import ssl
from typing import cast

import httpx
import pytest
from botocore.httpsession import get_cert_path

# GHSA-6q48-6c7w-9gw2 / PYSEC-2026-4320: eight eMudhra intermediates under this root have
# compromised keys; certifi 2026.10.18 removed it.
REVOKED_ROOTS = frozenset({"emSign ECC Root CA - G3"})

# A certificate's subject as the ssl module returns it: a tuple of RDNs, each a tuple of
# (name, value) pairs (typeshed types the whole dict's values as one wider union).
Subject = tuple[tuple[tuple[str, str], ...], ...]


def trusted_common_names(context: ssl.SSLContext) -> set[str]:
    return {
        value
        for cert in context.get_ca_certs()
        for rdn in cast(Subject, cert.get("subject", ()))
        for key, value in rdn
        if key == "commonName"
    }


@pytest.fixture(autouse=True)
def deployed_trust_settings(monkeypatch: pytest.MonkeyPatch) -> None:
    """As on Railway: no SSL_CERT_* override, so both clients fall back to certifi."""
    monkeypatch.delenv("SSL_CERT_FILE", raising=False)
    monkeypatch.delenv("SSL_CERT_DIR", raising=False)


def test_the_httpx_clients_do_not_trust_a_revoked_root() -> None:
    trusted = trusted_common_names(httpx.create_ssl_context())

    assert trusted, "the default context loaded no CA bundle"
    assert trusted.isdisjoint(REVOKED_ROOTS)


def test_the_s3_client_does_not_trust_a_revoked_root() -> None:
    trusted = trusted_common_names(ssl.create_default_context(cafile=get_cert_path(True)))

    assert trusted, "botocore's bundle is empty"
    assert trusted.isdisjoint(REVOKED_ROOTS)
