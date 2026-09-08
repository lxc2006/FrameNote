from __future__ import annotations

from datetime import datetime, timezone
from typing import Literal
from urllib.parse import urlsplit

from pydantic import BaseModel, ConfigDict, Field, field_validator

from .security import is_valid_bvid


JobStatus = Literal[
    "queued", "running", "succeeded", "failed", "cancelled", "expired"
]
JobPhase = Literal[
    "queued", "resolving", "downloading", "merging", "analyzing", "ready"
]
BilibiliDownloadVariant = Literal["analysis"]
MediaSourceKind = Literal["upload", "bilibili", "douyin", "url"]


def utc_iso(timestamp: float) -> str:
    return (
        datetime.fromtimestamp(timestamp, tz=timezone.utc)
        .isoformat(timespec="seconds")
        .replace("+00:00", "Z")
    )


class CreateJobRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=False)

    bvid: str = Field(min_length=12, max_length=12)
    variant: BilibiliDownloadVariant = "analysis"
    directSummaryMaxSeconds: int = Field(default=0, ge=0, le=900)

    @field_validator("bvid")
    @classmethod
    def validate_bvid(cls, value: str) -> str:
        if not is_valid_bvid(value):
            raise ValueError("bvid must be a 12-character BVID such as BV1xx411c7mD")
        return value


class BilibiliPreviewRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=False)

    bvid: str = Field(min_length=12, max_length=12)

    @field_validator("bvid")
    @classmethod
    def validate_bvid(cls, value: str) -> str:
        if not is_valid_bvid(value):
            raise ValueError("bvid must be a 12-character BVID such as BV1xx411c7mD")
        return value


class BilibiliPreviewResponse(BaseModel):
    playbackUrl: str
    audioPlaybackUrl: str | None = None
    bvid: str
    title: str
    description: str | None = None
    durationSeconds: float = Field(gt=0)
    sizeBytes: int = Field(ge=0)
    width: int | None = Field(default=None, gt=0)
    height: int | None = Field(default=None, gt=0)
    filename: str


class DouyinPreviewRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    sourceUrl: str = Field(min_length=12, max_length=2_048)

    @field_validator("sourceUrl")
    @classmethod
    def validate_source_url(cls, value: str) -> str:
        parsed = urlsplit(value)
        hostname = (parsed.hostname or "").lower().rstrip(".")
        if (
            parsed.scheme != "https"
            or parsed.username is not None
            or parsed.password is not None
            or not (hostname == "douyin.com" or hostname.endswith(".douyin.com"))
        ):
            raise ValueError("sourceUrl must be an HTTPS Douyin share URL")
        return value


class DouyinPreviewResponse(BaseModel):
    playbackUrl: str
    sourceUrl: str
    videoId: str
    title: str
    description: str | None = None
    durationSeconds: float = Field(gt=0)
    sizeBytes: int = Field(ge=0)
    width: int | None = Field(default=None, gt=0)
    height: int | None = Field(default=None, gt=0)
    filename: str


class SourceResponse(BaseModel):
    kind: MediaSourceKind = "bilibili"
    bvid: str | None = None
    filename: str | None = None
    sourceUrl: str | None = None
    title: str | None = None
    durationSeconds: float | None = None
    description: str | None = None


class ArtifactResponse(BaseModel):
    playbackUrl: str
    downloadUrl: str
    filename: str
    mimeType: str
    sizeBytes: int
    sha256: str
    expiresAt: str
    width: int | None = None
    height: int | None = None


class ErrorResponse(BaseModel):
    code: str
    message: str
    retryable: bool


class AnalysisFrameResponse(BaseModel):
    url: str
    timestampSeconds: float = Field(ge=0)
    score: float
    sizeBytes: int = Field(gt=0)


class AnalysisAudioResponse(BaseModel):
    url: str
    mimeType: str
    sizeBytes: int = Field(gt=0)


class TranscriptionAudioResponse(BaseModel):
    url: str
    mimeType: Literal["audio/mpeg"]
    sizeBytes: int = Field(gt=0, le=10 * 1024 * 1024)
    startSeconds: float = Field(ge=0)
    endSeconds: float = Field(gt=0)


class AnalysisResponse(BaseModel):
    mode: Literal["direct", "keyframes"]
    audio: AnalysisAudioResponse | None = None
    transcriptionAudio: list[TranscriptionAudioResponse] = Field(
        min_length=1,
        max_length=32,
    )
    frames: list[AnalysisFrameResponse] = Field(max_length=64)


class JobResponse(BaseModel):
    jobId: str
    status: JobStatus
    phase: JobPhase
    progress: float = Field(ge=0, le=1)
    source: SourceResponse
    artifact: ArtifactResponse | None = None
    analysis: AnalysisResponse | None = None
    error: ErrorResponse | None = None


class JobListResponse(BaseModel):
    jobs: list[JobResponse]
