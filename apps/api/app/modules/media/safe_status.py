from enum import StrEnum


class MediaSafeStatus(StrEnum):
    """The privacy-safe copy of a request's photo or video (#173) or a job's photo (#298)."""

    PENDING = "pending"  # not made yet
    READY = "ready"  # safe_key holds it
    FAILED = "failed"  # the file could not be made safe: it is never served
