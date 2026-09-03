from __future__ import annotations

from datetime import datetime, timezone
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

from .security import is_valid_bvid


JobStatus = Literal[
    "queued", "running", "succeeded", "failed", "cancelled", "expired"
]
JobPhase = Literal[
    "queued", "resolving", "downloading", "merging", "analyzing", "ready"
]
BilibiliDownloadVariant = Literal["analysis"]
MediaSourceKind = Literal["upload", "bilibili", "url"]
TranscriptLanguage = Literal["zh", "ja", "en"]
WebExtractStatus = Literal["ok", "requires_browser", "skipped"]
WebExtractMethod = Literal["trafilatura", "pypdf"]


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


class TranscriptCueResponse(BaseModel):
    startSeconds: float = Field(ge=0)
    endSeconds: float = Field(ge=0)
    text: str


class TranscriptResponse(BaseModel):
    status: Literal["pending", "ready", "unavailable"]
    text: str
    cues: list[TranscriptCueResponse]
    language: str | None = None
    error: str | None = None


class TranscriptOptionsRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    languages: list[TranscriptLanguage] = Field(default_factory=list, max_length=3)

    @field_validator("languages")
    @classmethod
    def validate_languages(
        cls,
        value: list[TranscriptLanguage],
    ) -> list[TranscriptLanguage]:
        if len(set(value)) != len(value):
            raise ValueError("languages must not contain duplicates")
        return value


class AnalysisResponse(BaseModel):
    mode: Literal["direct", "keyframes"]
    audio: AnalysisAudioResponse | None = None
    frames: list[AnalysisFrameResponse] = Field(max_length=64)
    transcript: TranscriptResponse


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


class WebExtractRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    url: str = Field(min_length=8, max_length=4_096)


class WebExtractResponse(BaseModel):
    status: WebExtractStatus
    url: str
    finalUrl: str | None = None
    title: str | None = None
    publishedAt: str | None = None
    contentType: str | None = None
    text: str | None = None
    method: WebExtractMethod | None = None
    errorCode: str | None = None
    errorMessage: str | None = None
