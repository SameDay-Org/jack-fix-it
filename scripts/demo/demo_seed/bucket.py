"""The uploads bucket of a local S3 (a dev MinIO or RustFS starts empty): is it there, and
making it. Only ever for an endpoint on this machine; a deployed storage is left alone."""

from enum import StrEnum
from typing import Any
from urllib.parse import urlsplit

import boto3
from botocore.exceptions import BotoCoreError, ClientError

from app.config import Settings
from demo_seed.guard import LOCAL_HOSTS


class BucketState(StrEnum):
    READY = "ready"
    MISSING = "missing"
    UNREACHABLE = "unreachable"
    NOT_CONFIGURED = "not_configured"


def is_local(settings: Settings) -> bool:
    endpoint = settings.s3_endpoint_url
    return endpoint is not None and urlsplit(endpoint).hostname in LOCAL_HOSTS


def _client(settings: Settings) -> Any | None:
    """A boto3 S3 client on the settings' storage (boto3 ships no types); None when a setting
    is missing."""
    key, secret = settings.s3_access_key_id, settings.s3_secret_access_key
    if settings.s3_endpoint_url is None or key is None or secret is None:
        return None
    return boto3.client(
        "s3",
        endpoint_url=settings.s3_endpoint_url,
        aws_access_key_id=key.get_secret_value(),
        aws_secret_access_key=secret.get_secret_value(),
        region_name=settings.s3_region,
    )


def bucket_state(settings: Settings) -> BucketState:
    client = _client(settings)
    if client is None or settings.s3_bucket is None:
        return BucketState.NOT_CONFIGURED
    try:
        client.head_bucket(Bucket=settings.s3_bucket)
    except ClientError:
        return BucketState.MISSING
    except BotoCoreError:
        return BucketState.UNREACHABLE
    return BucketState.READY


def ensure_local_bucket(settings: Settings) -> BucketState:
    """Creates the bucket when it is missing and the endpoint is local; its state after."""
    state = bucket_state(settings)
    client = _client(settings)
    if state is not BucketState.MISSING or client is None or not is_local(settings):
        return state
    client.create_bucket(Bucket=settings.s3_bucket)
    return BucketState.READY
