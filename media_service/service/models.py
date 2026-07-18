from __future__ import annotations

from datetime import datetime, timezone
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

from .security import is_valid_bvid


JobStatus = Literal[
    "queued", "running", "succeeded", "failed", "cancelled", "expired"
]
JobPhase = Literal["queued", "resolving", "downloading", "merging", "ready"]


def utc_iso(timestamp: float) -> str:
    return (
        datetime.fromtimestamp(timestamp, tz=timezone.utc)
        .isoformat(timespec="seconds")
        .replace("+00:00", "Z")
    )


class CreateJobRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=False)

    bvid: str = Field(min_length=12, max_length=12)

    @field_validator("bvid")
    @classmethod
    def validate_bvid(cls, value: str) -> str:
        if not is_valid_bvid(value):
            raise ValueError("bvid must be a 12-character BVID such as BV1xx411c7mD")
        return value


class SourceResponse(BaseModel):
    bvid: str
    title: str | None = None
    durationSeconds: float | None = None


class ArtifactResponse(BaseModel):
    downloadUrl: str
    filename: str
    mimeType: str
    sizeBytes: int
    sha256: str
    expiresAt: str


class ErrorResponse(BaseModel):
    code: str
    message: str
    retryable: bool


class JobResponse(BaseModel):
    jobId: str
    status: JobStatus
    phase: JobPhase
    progress: float = Field(ge=0, le=1)
    source: SourceResponse
    artifact: ArtifactResponse | None = None
    error: ErrorResponse | None = None


class JobListResponse(BaseModel):
    jobs: list[JobResponse]
