from datetime import datetime
from enum import StrEnum

from pydantic import BaseModel, Field


class UploadPurpose(StrEnum):
    REQUEST_MEDIA = "request_media"
    JOB_PHOTO = "job_photo"
    PRO_DOCUMENT = "pro_document"
    PROFILE_PHOTO = "profile_photo"


class UploadRequest(BaseModel):
    purpose: UploadPurpose
    content_type: str = Field(max_length=100, description="An allowed MIME type, e.g. image/jpeg.")
    size_bytes: int = Field(description="Exact size of the file; it is signed into the URL.")


class UploadResponse(BaseModel):
    key: str = Field(description="Where the file will live; features store it.")
    upload_url: str = Field(description="Presigned PUT URL.")
    headers: dict[str, str] = Field(
        description="Send exactly these headers with the PUT, or the storage rejects it."
    )
    expires_at: datetime


class DownloadUrlRequest(BaseModel):
    key: str = Field(max_length=256)


class DownloadUrlResponse(BaseModel):
    url: str = Field(description="Presigned GET URL.")
    expires_at: datetime
