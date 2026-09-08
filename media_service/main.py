from __future__ import annotations

import asyncio
import hmac
import importlib.util
import json
import logging
import mimetypes
import re
import shutil
import sys
import tempfile
import time
from contextlib import asynccontextmanager
from pathlib import Path
from urllib.parse import urlencode

from fastapi import (
    Depends,
    FastAPI,
    File,
    Form,
    HTTPException,
    Query,
    Request,
    Response,
    UploadFile,
    status,
)
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from starlette.background import BackgroundTask

from .bilibili_preview import BilibiliPreviewError, resolve_bilibili_preview
from .bilibili_preview_proxy import (
    BilibiliPreviewProxyError,
    BilibiliPreviewSessionStore,
    open_bilibili_preview_stream,
)
from .douyin_preview import (
    DouyinPreviewError,
    is_douyin_url,
    resolve_douyin_preview,
)
from .web_extract import extract_web_document
from .service.config import Settings
from .service.job_manager import JobManager, JobRecord, QueueCapacityError
from .service.models import (
    AnalysisAudioResponse,
    AnalysisFrameResponse,
    AnalysisResponse,
    TranscriptionAudioResponse,
    ArtifactResponse,
    BilibiliPreviewRequest,
    BilibiliPreviewResponse,
    CreateJobRequest,
    DouyinPreviewRequest,
    DouyinPreviewResponse,
    ErrorResponse,
    JobListResponse,
    JobResponse,
    SourceResponse,
    WebExtractRequest,
    WebExtractResponse,
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
ANALYSIS_ASSET_RE = re.compile(
    r"^analysis-(?:audio\.mp3|asr-[0-9]{3}\.mp3|frame-[0-9]{3}\.jpg)$",
    re.ASCII,
)


def _is_windows_proactor_cleanup_reset(context: dict[str, object]) -> bool:
    exception = context.get("exception")
    handle = str(context.get("handle", ""))
    return (
        isinstance(exception, ConnectionResetError)
        and getattr(exception, "winerror", None) == 10054
        and "_ProactorBasePipeTransport._call_connection_lost" in handle
    )


def _install_windows_proactor_cleanup_filter():
    if sys.platform != "win32":
        return lambda: None

    loop = asyncio.get_running_loop()
    previous_handler = loop.get_exception_handler()

    def handle_exception(
        current_loop: asyncio.AbstractEventLoop,
        context: dict[str, object],
    ) -> None:
        if _is_windows_proactor_cleanup_reset(context):
            LOGGER.debug("Ignored a closed Windows subprocess pipe")
            return
        if previous_handler is not None:
            previous_handler(current_loop, context)
        else:
            current_loop.default_exception_handler(context)

    loop.set_exception_handler(handle_exception)

    def restore() -> None:
        loop.set_exception_handler(previous_handler)

    return restore


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
    restore_exception_handler = _install_windows_proactor_cleanup_filter()
    manager = JobManager(SETTINGS)
    app.state.job_manager = manager
    app.state.bilibili_preview_store = BilibiliPreviewSessionStore()
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
        restore_exception_handler()


app = FastAPI(
    title="FrameNote Media Service",
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
        allow_methods=["GET", "HEAD", "POST", "DELETE", "OPTIONS"],
        allow_headers=["Authorization", "Content-Type", "Range"],
        expose_headers=[
            "Location",
            "Content-Disposition",
            "Accept-Ranges",
            "Content-Length",
            "Content-Range",
            "ETag",
        ],
        max_age=600,
    )


def manager_from_request(request: Request) -> JobManager:
    return request.app.state.job_manager


def preview_store_from_request(request: Request) -> BilibiliPreviewSessionStore:
    return request.app.state.bilibili_preview_store


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


def _read_analysis_manifest(job: JobRecord) -> dict:
    if job.analysis_manifest_file != "analysis-manifest.json":
        raise ValueError("analysis manifest is unavailable")
    job_dir = safe_job_dir(SETTINGS.state_root, job.job_id)
    manifest_path = safe_artifact_path(job_dir, job.analysis_manifest_file)
    if (
        not manifest_path.is_file()
        or manifest_path.is_symlink()
        or manifest_path.stat().st_size > 2 * 1024 * 1024
    ):
        raise ValueError("analysis manifest is invalid")
    value = json.loads(manifest_path.read_text(encoding="utf-8"))
    if not isinstance(value, dict) or value.get("version") != 1:
        raise ValueError("analysis manifest version is invalid")
    return value


def _analysis_response(
    request: Request,
    job: JobRecord,
    expires: int,
    signature: str,
) -> AnalysisResponse | None:
    if job.variant != "analysis" or not job.analysis_manifest_file:
        return None
    try:
        manifest = _read_analysis_manifest(job)
        base_url = (
            f"{get_public_base_url(request)}{job_route_prefix(job)}/"
            f"{job.job_id}/analysis"
        )

        def asset_url(filename: str) -> str:
            if not ANALYSIS_ASSET_RE.fullmatch(filename):
                raise ValueError("analysis asset filename is invalid")
            query = urlencode({"expires": expires, "signature": signature})
            return f"{base_url}/{filename}?{query}"

        mode = manifest.get("mode", "keyframes")
        if mode not in {"direct", "keyframes"}:
            raise ValueError("analysis mode is invalid")
        raw_audio = manifest.get("audio")
        audio = (
            AnalysisAudioResponse(
                url=asset_url(raw_audio["filename"]),
                mimeType=raw_audio["mimeType"],
                sizeBytes=raw_audio["sizeBytes"],
            )
            if isinstance(raw_audio, dict)
            else None
        )
        frames = [
            AnalysisFrameResponse(
                url=asset_url(frame["filename"]),
                timestampSeconds=frame["timestampSeconds"],
                score=frame["score"],
                sizeBytes=frame["sizeBytes"],
            )
            for frame in manifest["frames"][:64]
        ]
        transcription_audio = [
            TranscriptionAudioResponse(
                url=asset_url(chunk["filename"]),
                mimeType=chunk["mimeType"],
                sizeBytes=chunk["sizeBytes"],
                startSeconds=chunk["startSeconds"],
                endSeconds=chunk["endSeconds"],
            )
            for chunk in manifest["transcriptionAudio"][:32]
        ]
        if mode == "direct" and frames:
            raise ValueError("direct analysis must not contain keyframes")
        if mode == "keyframes" and (len(frames) < 3 or audio is None):
            raise ValueError(
                "keyframe analysis requires audio and at least three frames"
            )
        return AnalysisResponse(
            mode=mode,
            audio=audio,
            transcriptionAudio=transcription_audio,
            frames=frames,
        )
    except (KeyError, TypeError, ValueError, OSError, json.JSONDecodeError):
        LOGGER.exception("invalid analysis manifest for job %s", job.job_id)
        return None


def job_response(request: Request, job: JobRecord) -> JobResponse:
    artifact_response: ArtifactResponse | None = None
    analysis_response: AnalysisResponse | None = None
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
        artifact_url = (
            f"{get_public_base_url(request)}{job_route_prefix(job)}/"
            f"{job.job_id}/artifact"
        )
        playback_query = urlencode(
            {
                "expires": link_expires,
                "signature": signature,
                "download": 0,
            }
        )
        download_query = urlencode(
            {
                "expires": link_expires,
                "signature": signature,
                "download": 1,
            }
        )
        artifact_response = ArtifactResponse(
            playbackUrl=f"{artifact_url}?{playback_query}",
            downloadUrl=f"{artifact_url}?{download_query}",
            filename=job.artifact_filename,
            mimeType=job.artifact_mime_type,
            sizeBytes=job.artifact_size_bytes,
            sha256=job.artifact_sha256,
            expiresAt=utc_iso(link_expires),
            width=job.artifact_width,
            height=job.artifact_height,
        )
        analysis_response = _analysis_response(
            request,
            job,
            link_expires,
            signature,
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
            kind=job.source_kind,  # type: ignore[arg-type]
            bvid=job.bvid or None,
            filename=job.source_name,
            sourceUrl=job.source_url,
            title=job.title,
            durationSeconds=job.duration_seconds,
            description=job.description,
        ),
        artifact=artifact_response,
        analysis=analysis_response,
        error=error_response,
    )


def job_route_prefix(job: JobRecord) -> str:
    return (
        "/v1/bilibili/jobs"
        if job.source_kind == "bilibili"
        else "/v1/media/jobs"
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
        "sceneDetect": importlib.util.find_spec("scenedetect") is not None,
        "imageHash": importlib.util.find_spec("imagehash") is not None,
        "trafilatura": importlib.util.find_spec("trafilatura") is not None,
        "pypdf": importlib.util.find_spec("pypdf") is not None,
    }
    healthy = all(dependencies.values())
    return JSONResponse(
        {
            "status": "ok" if healthy else "degraded",
            "service": "framenote-media-core",
            "version": "1.1.0",
            "dependencies": dependencies,
            "jobs": queue,
        },
        status_code=status.HTTP_200_OK if healthy else status.HTTP_503_SERVICE_UNAVAILABLE,
    )


@app.post(
    "/v1/web/extract",
    response_model=WebExtractResponse,
    response_model_exclude_none=True,
    dependencies=[Depends(require_api_access)],
)
async def extract_web_page(body: WebExtractRequest) -> WebExtractResponse:
    return await extract_web_document(body.url)


@app.post(
    "/v1/bilibili/preview",
    response_model=BilibiliPreviewResponse,
    response_model_exclude_none=True,
    dependencies=[Depends(require_api_access)],
)
async def resolve_bilibili_video_preview(
    body: BilibiliPreviewRequest,
    request: Request,
    preview_store: BilibiliPreviewSessionStore = Depends(preview_store_from_request),
) -> BilibiliPreviewResponse:
    try:
        preview = await resolve_bilibili_preview(body.bvid)
    except BilibiliPreviewError as exc:
        raise api_error(
            status.HTTP_502_BAD_GATEWAY if exc.retryable else status.HTTP_503_SERVICE_UNAVAILABLE,
            exc.code,
            exc.message,
        ) from exc
    preview_session = preview_store.create(preview)
    preview_base_url = (
        f"{get_public_base_url(request)}/v1/bilibili/preview/"
        f"{preview_session.session_id}"
    )
    return BilibiliPreviewResponse(
        playbackUrl=f"{preview_base_url}/video",
        audioPlaybackUrl=(
            f"{preview_base_url}/audio" if preview.audio_track is not None else None
        ),
        bvid=preview.bvid,
        title=preview.title,
        description=preview.description,
        durationSeconds=preview.duration_seconds,
        sizeBytes=preview.size_bytes,
        width=preview.width,
        height=preview.height,
        filename=preview.filename,
    )


async def _stream_bilibili_preview_track(
    request: Request,
    session_id: str,
    track_kind: str,
    preview_store: BilibiliPreviewSessionStore,
) -> StreamingResponse:
    try:
        track = preview_store.track(
            session_id,
            "audio" if track_kind == "audio" else "video",
        )
        upstream = await open_bilibili_preview_stream(
            track,
            request.headers.get("range"),
        )
    except BilibiliPreviewProxyError as exc:
        raise api_error(exc.status_code, exc.code, exc.message) from exc
    return StreamingResponse(
        upstream.response.aiter_raw(),
        status_code=upstream.response.status_code,
        headers=upstream.response_headers(),
        background=BackgroundTask(upstream.close),
    )


@app.get("/v1/bilibili/preview/{session_id}/video")
async def stream_bilibili_preview_video(
    request: Request,
    session_id: str,
    preview_store: BilibiliPreviewSessionStore = Depends(preview_store_from_request),
) -> StreamingResponse:
    return await _stream_bilibili_preview_track(
        request,
        session_id,
        "video",
        preview_store,
    )


@app.get("/v1/bilibili/preview/{session_id}/audio")
async def stream_bilibili_preview_audio(
    request: Request,
    session_id: str,
    preview_store: BilibiliPreviewSessionStore = Depends(preview_store_from_request),
) -> StreamingResponse:
    return await _stream_bilibili_preview_track(
        request,
        session_id,
        "audio",
        preview_store,
    )


@app.post(
    "/v1/douyin/preview",
    response_model=DouyinPreviewResponse,
    response_model_exclude_none=True,
    dependencies=[Depends(require_api_access)],
)
async def resolve_douyin_video_preview(
    body: DouyinPreviewRequest,
    request: Request,
    preview_store: BilibiliPreviewSessionStore = Depends(preview_store_from_request),
) -> DouyinPreviewResponse:
    try:
        preview = await resolve_douyin_preview(body.sourceUrl)
    except DouyinPreviewError as exc:
        raise api_error(
            status.HTTP_502_BAD_GATEWAY if exc.retryable else status.HTTP_403_FORBIDDEN,
            exc.code,
            exc.message,
        ) from exc
    preview_session = preview_store.create(preview)  # type: ignore[arg-type]
    preview_base_url = (
        f"{get_public_base_url(request)}/v1/douyin/preview/"
        f"{preview_session.session_id}"
    )
    return DouyinPreviewResponse(
        playbackUrl=f"{preview_base_url}/video",
        sourceUrl=preview.source_url,
        videoId=preview.video_id,
        title=preview.title,
        description=preview.description,
        durationSeconds=preview.duration_seconds,
        sizeBytes=preview.size_bytes,
        width=preview.width,
        height=preview.height,
        filename=preview.filename,
    )


@app.get("/v1/douyin/preview/{session_id}/video")
async def stream_douyin_preview_video(
    request: Request,
    session_id: str,
    preview_store: BilibiliPreviewSessionStore = Depends(preview_store_from_request),
) -> StreamingResponse:
    return await _stream_bilibili_preview_track(
        request,
        session_id,
        "video",
        preview_store,
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
        job = await manager.create(
            body.bvid,
            body.variant,
            body.directSummaryMaxSeconds,
        )
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


@app.post(
    "/v1/media/jobs",
    response_model=JobResponse,
    response_model_exclude_none=True,
    status_code=status.HTTP_202_ACCEPTED,
    dependencies=[Depends(require_api_access)],
)
async def create_media_job(
    request: Request,
    response: Response,
    file: UploadFile = File(...),
    sourceKind: str = Form(...),
    directSummaryMaxSeconds: int = Form(default=0, ge=0, le=900),
    sourceUrl: str | None = Form(default=None),
) -> JobResponse:
    if sourceKind not in {"upload", "douyin", "url"}:
        raise api_error(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "INVALID_SOURCE",
            "媒体来源只支持本地上传、抖音分享链接或 HTTPS 视频直链。",
        )
    if sourceKind == "url" and (
        not sourceUrl
        or not sourceUrl.startswith("https://")
        or len(sourceUrl) > 4_096
    ):
        raise api_error(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "INVALID_SOURCE_URL",
            "HTTPS 视频直链无效。",
        )
    if sourceKind == "douyin" and (not sourceUrl or not is_douyin_url(sourceUrl)):
        raise api_error(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "INVALID_DOUYIN_URL",
            "抖音分享链接无效。",
        )
    raw_filename = Path(file.filename or "video.mp4").name
    if not raw_filename or len(raw_filename) > 240:
        raise api_error(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "INVALID_FILENAME",
            "视频文件名无效。",
        )
    content_length = request.headers.get("content-length")
    if (
        content_length
        and content_length.isdigit()
        and int(content_length) > SETTINGS.max_bytes + 1024 * 1024
    ):
        raise api_error(
            status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            "VIDEO_TOO_LARGE",
            "视频超过 500 MB 分析上限。",
        )

    SETTINGS.state_root.mkdir(parents=True, exist_ok=True)
    temporary = tempfile.NamedTemporaryFile(
        dir=SETTINGS.state_root,
        prefix=".incoming-",
        delete=False,
    )
    temporary_path = Path(temporary.name)
    received = 0
    try:
        with temporary:
            while chunk := await file.read(1024 * 1024):
                received += len(chunk)
                if received > SETTINGS.max_bytes:
                    raise api_error(
                        status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                        "VIDEO_TOO_LARGE",
                        "视频超过 500 MB 分析上限。",
                    )
                temporary.write(chunk)
        if received <= 0:
            raise api_error(
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                "EMPTY_MEDIA",
                "没有收到视频内容。",
            )
        manager = manager_from_request(request)
        job = await manager.create_media_file(
            temporary_path,
            raw_filename,
            sourceKind,
            directSummaryMaxSeconds,
            sourceUrl,
        )
    except QueueCapacityError as exc:
        raise api_error(
            status.HTTP_429_TOO_MANY_REQUESTS,
            "QUEUE_FULL",
            "媒体处理队列已满，请稍后重试。",
        ) from exc
    except RuntimeError as exc:
        raise api_error(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            "SERVICE_UNAVAILABLE",
            "媒体处理服务暂不可用。",
        ) from exc
    finally:
        await file.close()
        temporary_path.unlink(missing_ok=True)

    response.headers["Location"] = f"/v1/media/jobs/{job.job_id}"
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
    "/v1/media/jobs/{job_id}",
    response_model=JobResponse,
    response_model_exclude_none=True,
    dependencies=[Depends(require_api_access)],
)
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
    "/v1/media/jobs/{job_id}",
    response_model=JobResponse,
    response_model_exclude_none=True,
    dependencies=[Depends(require_api_access)],
)
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


def artifact_file_response(
    artifact: Path,
    media_type: str,
    filename: str,
    expires: int,
    *,
    as_download: bool,
) -> FileResponse:
    remaining_seconds = max(0, expires - int(time.time()))
    return FileResponse(
        path=artifact,
        media_type=media_type,
        filename=filename,
        content_disposition_type="attachment" if as_download else "inline",
        headers={
            "Accept-Ranges": "bytes",
            "Cache-Control": (
                "private, no-store"
                if as_download
                else f"private, max-age={remaining_seconds}"
            ),
            "X-Content-Type-Options": "nosniff",
        },
    )


@app.get("/v1/media/jobs/{job_id}/artifact", name="download_media_artifact")
@app.get("/v1/bilibili/jobs/{job_id}/artifact", name="download_artifact")
async def download_artifact(
    job_id: str,
    request: Request,
    expires: int = Query(ge=1),
    signature: str = Query(min_length=1, max_length=128),
    download: bool = Query(default=True),
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
    return artifact_file_response(
        artifact,
        job.artifact_mime_type,
        job.artifact_filename,
        expires,
        as_download=download,
    )


@app.get("/v1/media/jobs/{job_id}/analysis/{asset_name}")
@app.get("/v1/bilibili/jobs/{job_id}/analysis/{asset_name}")
async def download_analysis_asset(
    job_id: str,
    asset_name: str,
    request: Request,
    expires: int = Query(ge=1),
    signature: str = Query(min_length=1, max_length=128),
) -> FileResponse:
    if not is_valid_job_id(job_id) or not ANALYSIS_ASSET_RE.fullmatch(asset_name):
        raise api_error(status.HTTP_404_NOT_FOUND, "ASSET_NOT_FOUND", "分析素材不存在。")
    now = int(time.time())
    if expires < now or not verify_download_signature(
        SETTINGS.signing_secret, job_id, expires, signature
    ):
        raise api_error(
            status.HTTP_403_FORBIDDEN,
            "INVALID_DOWNLOAD_SIGNATURE",
            "分析素材链接无效或已过期。",
        )
    manager = manager_from_request(request)
    job = await refreshed_job(manager, job_id)
    if (
        not job
        or job.status != "succeeded"
        or job.variant != "analysis"
        or not job.artifact_expires_at
        or expires > int(job.artifact_expires_at)
    ):
        raise api_error(status.HTTP_410_GONE, "ASSET_EXPIRED", "分析素材已过期。")
    try:
        manifest = _read_analysis_manifest(job)
        raw_audio = manifest.get("audio")
        allowed = (
            {raw_audio["filename"]}
            if isinstance(raw_audio, dict)
            else set()
        ) | {
            chunk["filename"] for chunk in manifest["transcriptionAudio"]
        } | {
            frame["filename"] for frame in manifest["frames"]
        }
        if asset_name not in allowed:
            raise ValueError("asset is not in manifest")
        job_dir = safe_job_dir(SETTINGS.state_root, job_id)
        asset = safe_artifact_path(job_dir, asset_name)
        if not asset.is_file() or asset.is_symlink():
            raise OSError("asset missing")
    except (KeyError, TypeError, OSError, ValueError, json.JSONDecodeError) as exc:
        raise api_error(
            status.HTTP_410_GONE,
            "ASSET_EXPIRED",
            "分析素材不存在或已过期。",
        ) from exc
    media_type = mimetypes.guess_type(asset.name)[0] or "application/octet-stream"
    return artifact_file_response(
        asset,
        media_type,
        asset.name,
        expires,
        as_download=False,
    )
