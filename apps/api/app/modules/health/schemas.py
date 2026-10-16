from enum import StrEnum
from typing import Literal

from pydantic import BaseModel


class CheckStatus(StrEnum):
    OK = "ok"
    FAIL = "fail"


class LivenessResponse(BaseModel):
    status: Literal["ok"] = "ok"


class DependencyChecks(BaseModel):
    database: CheckStatus
    redis: CheckStatus


class ReadinessResponse(BaseModel):
    status: Literal["ok", "unavailable"]
    checks: DependencyChecks
