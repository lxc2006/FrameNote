from __future__ import annotations

import hmac
import importlib.util
import logging
import shutil
import time
from contextlib import asynccontextmanager
from pathlib import Path
from urllib.parse import urlencode

from fastapi import Depends, FastAPI, HTTPException, Query, Request, Response, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse

from .service.config import Settings
from .service.job_manager import JobManager, JobRecord, QueueCapacityError
from .service.models import (
    ArtifactResponse,
    CreateJobRequest,
    ErrorResponse,
    JobListResponse,
    JobResponse,
    SourceResponse,
    utc_iso,
)
from .service.security import (
    is_loopback_address,
    is_valid_job_id,
    safe_artifact_path,
    safe_job_dir,
    sign_download,
    verify_download_signature,
)


LOGGER = logging.getLogger("media_service")
SETTINGS = Settings.from_env()


@asynccontextmanager
async def lifespan(app: FastAPI):
    if (
        not SETTINGS.api_token
        and (
            not SETTINGS.allow_tokenless_loopback
            or SETTINGS.public_base_url is not None
        )
    ):
        raise RuntimeError(
            "FRAMENOTE_MEDIA_API_TOKEN is required outside direct loopback development"
        )
    manager = JobManager(SETTINGS)
    app.state.job_manager = manager
    if SETTINGS.signing_secret_is_ephemeral:
        LOGGER.warning(
            "FRAMENOTE_MEDIA_SIGNING_SECRET is unset; signed URLs will stop working "
            "after a service restart"
        )
    await manager.start()
    try:
        yield
    finally:
        await manager.stop()


app = FastAPI(
    title="FrameNote Bilibili Media Service",
    version="1.0.0",
    docs_url=None,
    redoc_url=None,
    openapi_url=None,
    lifespan=lifespan,
)

if SETTINGS.cors_origins:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=list(SETTINGS.cors_origins),
        allow_credentials=False,
        allow_methods=["GET", "POST", "DELETE", "OPTIONS"],
        allow_headers=["Authorization", "Content-Type"],
        expose_headers=["Location", "Content-Disposition"],
        max_age=600,
    )


def manager_from_request(request: Request) -> JobManager:
    return request.app.state.job_manager


async def require_api_access(request: Request) -> None:
    configured_token = SETTINGS.api_token
    if configured_token:
        authorization = request.headers.get("authorization", "")
        scheme, separator, supplied_token = authorization.partition(" ")
        if (
            not separator
            or scheme.lower() != "bearer"
            or not hmac.compare_digest(
                supplied_token.encode("utf-8"), configured_token.encode("utf-8")
            )
        ):
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail={
                    "code": "UNAUTHORIZED",
                    "message": "缺少或提供了错误的媒体服务令牌。",
                },
                headers={"WWW-Authenticate": "Bearer"},
            )
        return

    if not SETTINGS.allow_tokenless_loopback:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail={
                "code": "TOKEN_REQUIRED",
                "message": "媒体服务必须先配置访问令牌。",
            },
        )

    # Tokenless mode is intentionally local-only. Forwarding headers are rejected
    # because a reverse proxy would otherwise make a public client appear local.
    if (
        request.headers.get("forwarded")
        or request.headers.get("x-forwarded-for")
        or request.headers.get("x-real-ip")
        or not is_loopback_address(request.client.host if request.client else None)
    ):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={
                "code": "LOCAL_ONLY",
                "message": "未配置令牌时，媒体服务只接受本机请求。",
            },
        )


def api_error(status_code: int, code: str, message: str) -> HTTPException:
    return HTTPException(
        status_code=status_code,
        detail={"code": code, "message": message},
    )


def get_public_base_url(request: Request) -> str:
    if SETTINGS.public_base_url:
        return SETTINGS.public_base_url
    return str(request.base_url).rstrip("/")


def job_response(request: Request, job: JobRecord) -> JobResponse:
    artifact_response: ArtifactResponse | None = None
    if (
        job.status == "succeeded"
        and job.artifact_file
        and job.artifact_filename
        and job.artifact_mime_type
        and job.artifact_size_bytes is not None
        and job.artifact_sha256
        and job.artifact_expires_at
    ):
        link_expires = min(
            int(job.artifact_expires_at),
            int(time.time()) + SETTINGS.signed_url_ttl_seconds,
        )
        signature = sign_download(
            SETTINGS.signing_secret, job.job_id, link_expires
        )
        query = urlencode({"expires": link_expires, "signature": signature})
        download_url = (
            f"{get_public_base_url(request)}/v1/bilibili/jobs/"
            f"{job.job_id}/artifact?{query}"
        )
        artifact_response = ArtifactResponse(
            downloadUrl=download_url,
            filename=job.artifact_filename,
            mimeType=job.artifact_mime_type,
            sizeBytes=job.artifact_size_bytes,
            sha256=job.artifact_sha256,
            expiresAt=utc_iso(link_expires),
            height=job.artifact_height,
        )
    error_response = (
        ErrorResponse(
            code=job.error.code,
            message=job.error.message,
            retryable=job.error.retryable,
        )
        if job.error
        else None
    )
    return JobResponse(
        jobId=job.job_id,
        status=job.status,  # type: ignore[arg-type]
        phase=job.phase,  # type: ignore[arg-type]
        progress=round(job.progress, 4),
        source=SourceResponse(
            bvid=job.bvid,
            title=job.title,
            durationSeconds=job.duration_seconds,
        ),
        artifact=artifact_response,
        error=error_response,
    )


async def refreshed_job(manager: JobManager, job_id: str) -> JobRecord | None:
    job = await manager.get(job_id)
    if (
        job
        and job.status == "succeeded"
        and job.artifact_expires_at
        and job.artifact_expires_at <= time.time()
    ):
        await manager.cleanup_once()
        job = await manager.get(job_id)
    return job


@app.get("/health")
async def health(request: Request) -> JSONResponse:
    manager = manager_from_request(request)
    queue = await manager.health()
    dependencies = {
        "ytDlp": importlib.util.find_spec("yt_dlp") is not None,
        "ffmpeg": shutil.which("ffmpeg") is not None,
        "ffprobe": shutil.which("ffprobe") is not None,
    }
    healthy = all(dependencies.values())
    return JSONResponse(
        {
            "status": "ok" if healthy else "degraded",
            "dependencies": dependencies,
            "jobs": queue,
        },
        status_code=status.HTTP_200_OK if healthy else status.HTTP_503_SERVICE_UNAVAILABLE,
    )


@app.post(
    "/v1/bilibili/jobs",
    response_model=JobResponse,
    response_model_exclude_none=True,
    status_code=status.HTTP_202_ACCEPTED,
    dependencies=[Depends(require_api_access)],
)
async def create_job(
    body: CreateJobRequest,
    request: Request,
    response: Response,
) -> JobResponse:
    manager = manager_from_request(request)
    try:
        job = await manager.create(body.bvid, body.maxHeight)
    except QueueCapacityError as exc:
        raise api_error(
            status.HTTP_429_TOO_MANY_REQUESTS,
            "QUEUE_FULL",
            "下载队列已满，请稍后重试。",
        ) from exc
    except RuntimeError as exc:
        raise api_error(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            "SERVICE_UNAVAILABLE",
            "下载服务暂不可用。",
        ) from exc
    response.headers["Location"] = f"/v1/bilibili/jobs/{job.job_id}"
    response.headers["Cache-Control"] = "no-store"
    return job_response(request, job)


@app.get(
    "/v1/bilibili/jobs",
    response_model=JobListResponse,
    response_model_exclude_none=True,
    dependencies=[Depends(require_api_access)],
)
async def list_jobs(
    request: Request,
    limit: int = Query(default=50, ge=1, le=100),
) -> JobListResponse:
    manager = manager_from_request(request)
    jobs = await manager.list(limit)
    return JobListResponse(jobs=[job_response(request, job) for job in jobs])


@app.get(
    "/v1/bilibili/jobs/{job_id}",
    response_model=JobResponse,
    response_model_exclude_none=True,
    dependencies=[Depends(require_api_access)],
)
async def get_job(job_id: str, request: Request, response: Response) -> JobResponse:
    if not is_valid_job_id(job_id):
        raise api_error(status.HTTP_404_NOT_FOUND, "JOB_NOT_FOUND", "任务不存在。")
    manager = manager_from_request(request)
    job = await refreshed_job(manager, job_id)
    if not job:
        raise api_error(status.HTTP_404_NOT_FOUND, "JOB_NOT_FOUND", "任务不存在。")
    response.headers["Cache-Control"] = "no-store"
    return job_response(request, job)


@app.delete(
    "/v1/bilibili/jobs/{job_id}",
    response_model=JobResponse,
    response_model_exclude_none=True,
    dependencies=[Depends(require_api_access)],
)
async def delete_job(job_id: str, request: Request, response: Response) -> JobResponse:
    if not is_valid_job_id(job_id):
        raise api_error(status.HTTP_404_NOT_FOUND, "JOB_NOT_FOUND", "任务不存在。")
    manager = manager_from_request(request)
    job = await manager.cancel(job_id)
    if not job:
        raise api_error(status.HTTP_404_NOT_FOUND, "JOB_NOT_FOUND", "任务不存在。")
    response.headers["Cache-Control"] = "no-store"
    return job_response(request, job)


@app.get("/v1/bilibili/jobs/{job_id}/artifact", name="download_artifact")
async def download_artifact(
    job_id: str,
    request: Request,
    expires: int = Query(ge=1),
    signature: str = Query(min_length=1, max_length=128),
) -> FileResponse:
    if not is_valid_job_id(job_id):
        raise api_error(status.HTTP_404_NOT_FOUND, "JOB_NOT_FOUND", "任务不存在。")
    now = int(time.time())
    if expires < now or not verify_download_signature(
        SETTINGS.signing_secret, job_id, expires, signature
    ):
        raise api_error(
            status.HTTP_403_FORBIDDEN,
            "INVALID_DOWNLOAD_SIGNATURE",
            "下载链接无效或已过期。",
        )
    manager = manager_from_request(request)
    job = await refreshed_job(manager, job_id)
    if not job:
        raise api_error(status.HTTP_404_NOT_FOUND, "JOB_NOT_FOUND", "任务不存在。")
    if (
        job.status != "succeeded"
        or not job.artifact_file
        or not job.artifact_filename
        or not job.artifact_mime_type
        or not job.artifact_expires_at
        or expires > int(job.artifact_expires_at)
    ):
        raise api_error(status.HTTP_410_GONE, "ARTIFACT_EXPIRED", "视频文件已过期。")
    try:
        job_dir = safe_job_dir(SETTINGS.state_root, job_id)
        artifact = safe_artifact_path(job_dir, job.artifact_file)
        if not artifact.is_file() or artifact.is_symlink():
            raise OSError("artifact missing")
    except (OSError, ValueError) as exc:
        raise api_error(
            status.HTTP_410_GONE, "ARTIFACT_EXPIRED", "视频文件不存在或已过期。"
        ) from exc
    return FileResponse(
        path=artifact,
        media_type=job.artifact_mime_type,
        filename=job.artifact_filename,
        headers={
            "Cache-Control": "private, no-store",
            "X-Content-Type-Options": "nosniff",
        },
    )
