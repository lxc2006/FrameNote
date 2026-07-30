from __future__ import annotations

import argparse
import hashlib
import json
import math
import mimetypes
import os
import re
import shutil
import subprocess
import sys
import time
import unicodedata
from pathlib import Path
from typing import Any


BVID_RE = re.compile(r"^BV[0-9A-Za-z]{10}$", re.ASCII)
JOB_ID_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
    re.ASCII,
)
FINAL_ARTIFACT_RE = re.compile(r"^artifact\.mp4$", re.IGNORECASE)
SUPPORTED_VARIANTS = frozenset({"preview", "analysis"})
ANALYSIS_MAX_EDGE = 854
ANALYSIS_MAX_BYTES = 500 * 1024 * 1024
PREVIEW_MAX_BYTES = 2 * 1024 * 1024 * 1024
DOWNLOAD_FRAGMENT_CONCURRENCY = 4
DOWNLOAD_RETRIES = 10
BROWSER_VIDEO_CODECS = frozenset({"h264"})
BROWSER_AUDIO_CODECS = frozenset({"aac"})


class WorkerFailure(RuntimeError):
    def __init__(self, code: str, message: str, retryable: bool) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.retryable = retryable


def emit(event: str, **values: Any) -> None:
    payload = {"event": event, **values}
    sys.stdout.write(json.dumps(payload, ensure_ascii=False, separators=(",", ":")))
    sys.stdout.write("\n")
    sys.stdout.flush()


def load_analysis_builder():
    """Load the trusted sibling module even when the worker uses Python ``-I``."""
    package_root = str(Path(__file__).resolve().parent.parent)
    if package_root not in sys.path:
        sys.path.insert(0, package_root)
    from media_service.analysis_pipeline import build_analysis_manifest

    return build_analysis_manifest


def browser_compatible_format(variant: str) -> str:
    dimension_filter = (
        rf"[width<={ANALYSIS_MAX_EDGE}][height<={ANALYSIS_MAX_EDGE}]"
        if variant == "analysis"
        else ""
    )
    return (
        rf"bv{dimension_filter}[ext=mp4][vcodec~='^(?:h264|avc[13](?:\.|$))']"
        r"+ba[ext=m4a][acodec~='^(?:aac|mp4a\.40\.)']/"
        rf"b{dimension_filter}[ext=mp4][vcodec~='^(?:h264|avc[13](?:\.|$))']"
        r"[acodec~='^(?:aac|mp4a\.40\.)']"
    )

def resolve_job_dir(state_root: Path, job_id: str) -> Path:
    if not JOB_ID_RE.fullmatch(job_id):
        raise WorkerFailure("INVALID_JOB", "任务标识无效。", False)
    root = state_root.resolve()
    job_dir = (root / job_id).resolve()
    if job_dir.parent != root or not job_dir.is_dir() or job_dir.is_symlink():
        raise WorkerFailure("INVALID_JOB", "任务目录无效。", False)
    return job_dir


def estimate_download_bytes(info: dict[str, Any]) -> int | None:
    requested = info.get("requested_formats")
    values: list[int] = []
    if isinstance(requested, list):
        for item in requested:
            if not isinstance(item, dict):
                continue
            size = item.get("filesize") or item.get("filesize_approx")
            if isinstance(size, (int, float)) and math.isfinite(size) and size > 0:
                values.append(int(size))
        if values:
            return sum(values)
    size = info.get("filesize") or info.get("filesize_approx")
    if isinstance(size, (int, float)) and math.isfinite(size) and size > 0:
        return int(size)
    return None


def validate_video_info(
    info: dict[str, Any], max_duration: int, max_bytes: int
) -> tuple[str, float, str | None]:
    if not isinstance(info, dict) or info.get("_type") in {"playlist", "multi_video"}:
        raise WorkerFailure("PLAYLIST_NOT_ALLOWED", "只支持单个 B 站视频。", False)
    if info.get("extractor_key") != "BiliBili":
        raise WorkerFailure(
            "UNSUPPORTED_VIDEO", "只支持 B 站公开 UGC 视频，不支持番剧或其他来源。", False
        )
    availability = info.get("availability")
    if availability not in {None, "public"}:
        raise WorkerFailure(
            "ACCESS_RESTRICTED", "视频不是无需登录即可访问的公开内容。", False
        )
    if info.get("is_live") or info.get("was_live") or info.get("live_status") in {
        "is_live",
        "is_upcoming",
        "was_live",
        "post_live",
    }:
        raise WorkerFailure("LIVE_NOT_SUPPORTED", "暂不支持直播或直播回放任务。", False)
    duration = info.get("duration")
    if not isinstance(duration, (int, float)) or not math.isfinite(duration) or duration <= 0:
        raise WorkerFailure("DURATION_UNKNOWN", "无法确认视频时长，已拒绝下载。", False)
    if duration > max_duration:
        raise WorkerFailure("VIDEO_TOO_LONG", "视频超过 60 分钟限制。", False)
    estimated_size = estimate_download_bytes(info)
    if estimated_size is not None and estimated_size > max_bytes:
        raise WorkerFailure("VIDEO_TOO_LARGE", "预计下载内容超过媒体服务大小限制。", False)
    title = info.get("title")
    if not isinstance(title, str) or not title.strip():
        title = "Bilibili video"
    description = info.get("description")
    if not isinstance(description, str) or not description.strip():
        description = None
    else:
        description = description.strip()[:20_000]
    return title.strip()[:300], float(duration), description


def safe_download_filename(title: str, bvid: str, suffix: str) -> str:
    normalized = safe_filename_stem(title)
    return f"{normalized[:120].rstrip(' .')} [{bvid}]{suffix.lower()}"


def safe_media_filename(title: str, suffix: str = ".mp4") -> str:
    normalized = safe_filename_stem(Path(title).stem or title)
    return f"{normalized[:160].rstrip(' .')}{suffix.lower()}"


def safe_filename_stem(title: str) -> str:
    normalized = unicodedata.normalize("NFKC", title)
    normalized = "".join(char for char in normalized if ord(char) >= 32)
    normalized = re.sub(r'[<>:"/\\|?*]+', "_", normalized)
    normalized = re.sub(r"\s+", " ", normalized).strip(" .")
    if not normalized:
        normalized = bvid
    if normalized.upper() in {
        "CON", "PRN", "AUX", "NUL",
        *(f"COM{number}" for number in range(1, 10)),
        *(f"LPT{number}" for number in range(1, 10)),
    }:
        normalized = f"_{normalized}"
    return normalized


def directory_size(directory: Path) -> int:
    total = 0
    for item in directory.iterdir():
        if item.is_file() and not item.is_symlink():
            total += item.stat().st_size
    return total


class ProgressReporter:
    def __init__(self, job_dir: Path, max_bytes: int) -> None:
        self.job_dir = job_dir
        self.max_bytes = max_bytes
        self.downloads: dict[str, tuple[int, int | None]] = {}
        self.last_emit_at = 0.0
        self.last_progress = 0.08
        self.limit_exceeded = False

    def download_hook(self, value: dict[str, Any]) -> None:
        status = value.get("status")
        filename = str(value.get("filename") or "unknown")
        downloaded = value.get("downloaded_bytes")
        total = value.get("total_bytes") or value.get("total_bytes_estimate")
        downloaded_value = int(downloaded) if isinstance(downloaded, (int, float)) else 0
        total_value = int(total) if isinstance(total, (int, float)) and total > 0 else None
        self.downloads[filename] = (downloaded_value, total_value)

        observed = sum(item[0] for item in self.downloads.values())
        try:
            on_disk = directory_size(self.job_dir)
        except OSError:
            on_disk = observed
        if max(observed, on_disk) > self.max_bytes:
            self.limit_exceeded = True
            raise WorkerFailure("VIDEO_TOO_LARGE", "下载内容超过媒体服务大小限制。", False)

        totals = [item[1] for item in self.downloads.values()]
        if totals and all(item is not None for item in totals):
            denominator = sum(int(item or 0) for item in totals)
            fraction = observed / denominator if denominator else 0.0
        else:
            fraction = min(0.95, observed / self.max_bytes)
        progress = min(0.82, 0.08 + 0.74 * max(0.0, min(1.0, fraction)))
        progress = max(self.last_progress, progress)
        now = time.monotonic()
        if status == "finished" or now - self.last_emit_at >= 0.25:
            emit("progress", phase="downloading", progress=round(progress, 4))
            self.last_emit_at = now
            self.last_progress = progress

    def postprocessor_hook(self, value: dict[str, Any]) -> None:
        if value.get("status") in {"started", "processing"}:
            emit("progress", phase="merging", progress=0.88)


class QuietLogger:
    def debug(self, message: str) -> None:
        del message

    def warning(self, message: str) -> None:
        sys.stderr.write(f"yt-dlp warning: {message[:1000]}\n")

    def error(self, message: str) -> None:
        sys.stderr.write(f"yt-dlp error: {message[:1000]}\n")


def download_retry_delay(attempt: int) -> float:
    """Back off transient CDN failures without exceeding the job timeout."""
    return min(10.0, 2.0 ** max(0, attempt - 1))


def download_network_options() -> dict[str, Any]:
    options: dict[str, Any] = {
        "socket_timeout": 30,
        "retries": DOWNLOAD_RETRIES,
        "fragment_retries": DOWNLOAD_RETRIES,
        "file_access_retries": 3,
        "extractor_retries": 5,
        "retry_sleep_functions": {
            "http": download_retry_delay,
            "fragment": download_retry_delay,
            "extractor": download_retry_delay,
        },
    }
    proxy = (os.getenv("FRAMENOTE_MEDIA_PROXY") or "").strip()
    if proxy:
        options["proxy"] = proxy
    return options


def locate_ffmpeg() -> tuple[str, str]:
    ffmpeg = shutil.which("ffmpeg")
    ffprobe = shutil.which("ffprobe")
    if not ffmpeg or not ffprobe:
        raise WorkerFailure(
            "FFMPEG_NOT_FOUND", "服务器未安装 FFmpeg/ffprobe。", False
        )
    return str(Path(ffmpeg).resolve().parent), str(Path(ffprobe).resolve())


def find_artifact(job_dir: Path) -> Path:
    candidates = [
        item
        for item in job_dir.iterdir()
        if item.is_file()
        and not item.is_symlink()
        and FINAL_ARTIFACT_RE.fullmatch(item.name)
    ]
    if len(candidates) != 1:
        raise WorkerFailure("ARTIFACT_MISSING", "未生成可用的视频文件。", True)
    artifact = candidates[0].resolve()
    if artifact.parent != job_dir.resolve():
        raise WorkerFailure("ARTIFACT_MISSING", "视频输出路径无效。", False)
    return artifact


def validate_artifact_probe(
    payload: dict[str, Any], max_duration: int
) -> tuple[int | None, int | None]:
    try:
        format_name = payload["format"]["format_name"]
        duration = float(payload["format"]["duration"])
        streams = payload["streams"]
    except (KeyError, TypeError, ValueError) as exc:
        raise WorkerFailure("PROBE_FAILED", "视频媒体信息无效。", True) from exc
    if not isinstance(format_name, str) or "mp4" not in format_name.split(","):
        raise WorkerFailure(
            "UNSUPPORTED_CONTAINER",
            "下载结果不是浏览器可处理的 MP4 文件。",
            False,
        )
    if not isinstance(streams, list):
        raise WorkerFailure("PROBE_FAILED", "视频媒体信息无效。", True)
    if not math.isfinite(duration) or duration <= 0 or duration > max_duration + 1:
        raise WorkerFailure("VIDEO_TOO_LONG", "最终视频超过 60 分钟限制。", False)

    video_streams = [
        stream
        for stream in streams
        if isinstance(stream, dict) and stream.get("codec_type") == "video"
    ]
    if not video_streams:
        raise WorkerFailure("PROBE_FAILED", "下载结果不包含视频轨道。", True)
    if any(
        stream.get("codec_name") not in BROWSER_VIDEO_CODECS
        for stream in video_streams
    ):
        raise WorkerFailure(
            "UNSUPPORTED_VIDEO_CODEC",
            "下载结果不是浏览器可处理的 H.264 视频。",
            False,
        )
    dimensions = [
        (int(stream["width"]), int(stream["height"]))
        for stream in video_streams
        if isinstance(stream.get("width"), int)
        and isinstance(stream.get("height"), int)
        and stream["width"] > 0
        and stream["height"] > 0
    ]

    audio_streams = [
        stream
        for stream in streams
        if isinstance(stream, dict) and stream.get("codec_type") == "audio"
    ]
    if not audio_streams:
        raise WorkerFailure("PROBE_FAILED", "下载结果不包含音频轨道。", True)
    if any(
        stream.get("codec_name") not in BROWSER_AUDIO_CODECS
        for stream in audio_streams
    ):
        raise WorkerFailure(
            "UNSUPPORTED_AUDIO_CODEC",
            "下载结果不是浏览器可处理的 AAC 音频。",
            False,
        )
    if not dimensions:
        return None, None
    width, height = max(dimensions, key=lambda item: item[0] * item[1])
    return width, height


def verify_artifact(
    ffprobe: str, artifact: Path, max_duration: int, max_bytes: int
) -> tuple[int, str, int | None, int | None]:
    if artifact.suffix.lower() != ".mp4":
        raise WorkerFailure(
            "UNSUPPORTED_CONTAINER",
            "下载结果不是浏览器可处理的 MP4 文件。",
            False,
        )
    try:
        stat = artifact.stat()
    except OSError as exc:
        raise WorkerFailure("ARTIFACT_MISSING", "无法读取视频文件。", True) from exc
    if stat.st_size <= 0 or stat.st_size > max_bytes:
        raise WorkerFailure("VIDEO_TOO_LARGE", "最终视频超过媒体服务大小限制。", False)
    command = [
        ffprobe,
        "-v",
        "error",
        "-show_entries",
        "format=format_name,duration,size:stream=codec_type,codec_name,width,height",
        "-of",
        "json",
        str(artifact),
    ]
    try:
        result = subprocess.run(
            command,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
            timeout=30,
            text=True,
            encoding="utf-8",
            errors="replace",
            shell=False,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise WorkerFailure("PROBE_FAILED", "无法校验下载的视频。", True) from exc
    if result.returncode != 0:
        raise WorkerFailure("PROBE_FAILED", "下载的视频未通过媒体校验。", True)
    try:
        payload = json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        raise WorkerFailure("PROBE_FAILED", "视频媒体信息无效。", True) from exc
    width, height = validate_artifact_probe(payload, max_duration)
    digest = hashlib.sha256()
    with artifact.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return stat.st_size, digest.hexdigest(), width, height


def probe_source_media(
    ffprobe: str,
    source: Path,
    max_duration: int,
    max_bytes: int,
) -> float:
    try:
        stat = source.stat()
    except OSError as exc:
        raise WorkerFailure("SOURCE_MISSING", "无法读取上传的视频。", False) from exc
    if (
        not source.is_file()
        or source.is_symlink()
        or stat.st_size <= 0
        or stat.st_size > max_bytes
    ):
        raise WorkerFailure(
            "VIDEO_TOO_LARGE",
            "上传的视频为空或超过 500 MB 分析上限。",
            False,
        )
    command = [
        ffprobe,
        "-v",
        "error",
        "-show_entries",
        "format=duration:stream=codec_type",
        "-of",
        "json",
        str(source),
    ]
    try:
        result = subprocess.run(
            command,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
            timeout=45,
            text=True,
            encoding="utf-8",
            errors="replace",
            shell=False,
        )
        payload = json.loads(result.stdout) if result.returncode == 0 else {}
        duration = float(payload["format"]["duration"])
        stream_types = {
            stream.get("codec_type")
            for stream in payload.get("streams", [])
            if isinstance(stream, dict)
        }
    except (OSError, subprocess.TimeoutExpired, KeyError, TypeError, ValueError, json.JSONDecodeError) as exc:
        raise WorkerFailure(
            "PROBE_FAILED",
            "无法读取视频时长或媒体轨道。",
            False,
        ) from exc
    if not math.isfinite(duration) or duration <= 0:
        raise WorkerFailure("DURATION_UNKNOWN", "无法确认视频时长。", False)
    if duration > max_duration:
        raise WorkerFailure("VIDEO_TOO_LONG", "视频超过 60 分钟限制。", False)
    if "video" not in stream_types:
        raise WorkerFailure("PROBE_FAILED", "文件不包含视频轨道。", False)
    if "audio" not in stream_types:
        raise WorkerFailure(
            "AUDIO_MISSING",
            "视频不包含音频轨道，无法执行完整的视频总结与字幕提取。",
            False,
        )
    return duration


def transcode_analysis_video(
    ffmpeg: str,
    source: Path,
    artifact: Path,
    duration: float,
) -> None:
    command = [
        ffmpeg,
        "-hide_banner",
        "-loglevel",
        "error",
        "-nostdin",
        "-i",
        str(source),
        "-map",
        "0:v:0",
        "-map",
        "0:a:0",
        "-vf",
        (
            f"scale={ANALYSIS_MAX_EDGE}:{ANALYSIS_MAX_EDGE}:"
            "force_original_aspect_ratio=decrease:force_divisible_by=2"
        ),
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "28",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-b:a",
        "96k",
        "-movflags",
        "+faststart",
        "-y",
        str(artifact),
    ]
    try:
        result = subprocess.run(
            command,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            check=False,
            timeout=max(180, min(3_600, math.ceil(duration * 4))),
            text=True,
            encoding="utf-8",
            errors="replace",
            shell=False,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise WorkerFailure(
            "TRANSCODE_FAILED",
            "低分辨率分析视频生成超时或 FFmpeg 不可用。",
            True,
        ) from exc
    if result.returncode != 0 or not artifact.is_file():
        raise WorkerFailure(
            "TRANSCODE_FAILED",
            f"低分辨率分析视频生成失败：{result.stderr[-180:]}",
            True,
        )


def build_and_emit_analysis(
    args: argparse.Namespace,
    artifact: Path,
    job_dir: Path,
    duration: float,
) -> None:
    emit("progress", phase="analyzing", progress=0.92)
    try:
        build_analysis_manifest = load_analysis_builder()
        ffmpeg = shutil.which("ffmpeg")
        if not ffmpeg:
            raise RuntimeError("FFmpeg 不可用。")
        use_direct_video = (
            args.direct_summary_max_seconds > 0
            and duration <= args.direct_summary_max_seconds
        )
        manifest_path, manifest = build_analysis_manifest(
            artifact,
            job_dir,
            duration,
            ffmpeg,
            include_keyframes=not use_direct_video,
            on_progress=lambda _stage, progress: emit(
                "progress",
                phase="analyzing",
                progress=round(0.92 + min(1.0, max(0.0, progress)) * 0.07, 4),
            ),
        )
    except Exception as exc:
        raise WorkerFailure(
            "ANALYSIS_FAILED",
            f"Qwen 分析素材准备失败：{str(exc)[:220]}",
            True,
        ) from exc
    emit(
        "analysis",
        manifestFile=manifest_path.name,
        mode=manifest["mode"],
        frameCount=len(manifest["frames"]),
        transcriptStatus=manifest["transcript"]["status"],
    )


def run_uploaded_media(args: argparse.Namespace) -> None:
    validate_runtime_limits(
        args.variant,
        args.max_duration,
        args.max_bytes,
        args.direct_summary_max_seconds,
    )
    if args.variant != "analysis" or args.source_kind not in {"upload", "url"}:
        raise WorkerFailure("INVALID_SOURCE", "媒体分析来源无效。", False)
    state_root = Path(args.state_root)
    job_dir = resolve_job_dir(state_root, args.job_id)
    if not isinstance(args.input_file, str) or not args.input_file:
        raise WorkerFailure("INVALID_SOURCE", "上传视频路径无效。", False)
    source = (job_dir / args.input_file).resolve()
    if source.parent != job_dir.resolve() or source.name != args.input_file:
        raise WorkerFailure("INVALID_SOURCE", "上传视频路径无效。", False)
    ffmpeg_location, ffprobe = locate_ffmpeg()
    ffmpeg = str(Path(ffmpeg_location) / ("ffmpeg.exe" if os.name == "nt" else "ffmpeg"))

    emit("progress", phase="resolving", progress=0.05)
    duration = probe_source_media(
        ffprobe,
        source,
        args.max_duration,
        args.max_bytes,
    )
    title = Path(args.source_name).stem.strip() or "本地视频"
    emit(
        "source",
        title=title[:300],
        durationSeconds=round(duration, 3),
        description=None,
    )
    emit("progress", phase="merging", progress=0.15)
    artifact = job_dir / "artifact.mp4"
    transcode_analysis_video(ffmpeg, source, artifact, duration)
    source.unlink(missing_ok=True)
    emit("progress", phase="merging", progress=0.88)
    size, sha256, width, height = verify_artifact(
        ffprobe,
        artifact,
        args.max_duration,
        args.max_bytes,
    )
    build_and_emit_analysis(args, artifact, job_dir, duration)
    emit(
        "artifact",
        artifactFile=artifact.name,
        filename=safe_media_filename(args.source_name),
        mimeType="video/mp4",
        sizeBytes=size,
        sha256=sha256,
        width=width,
        height=height,
    )


def classify_download_error(message: str, resolving: bool) -> WorkerFailure:
    lowered = message.lower()
    if any(
        marker in lowered
        for marker in (
            "login required",
            "members-only",
            "private video",
            "premium",
            "not available in your region",
            "geo restricted",
            "该视频不存在",
            "账号登录",
        )
    ):
        return WorkerFailure(
            "ACCESS_RESTRICTED", "视频不存在或需要登录/地区权限，服务不会使用 Cookie。", False
        )
    if "unsupported url" in lowered:
        return WorkerFailure("UNSUPPORTED_VIDEO", "B 站视频无法解析。", False)
    if "requested format is not available" in lowered:
        return WorkerFailure(
            "UNSUPPORTED_VIDEO_CODEC",
            "视频没有可供浏览器处理的 H.264/AAC 格式。",
            False,
        )
    if resolving:
        return WorkerFailure("METADATA_FAILED", "无法获取 B 站视频信息，请稍后重试。", True)
    return WorkerFailure("DOWNLOAD_FAILED", "B 站视频下载失败，请稍后重试。", True)


def validate_runtime_limits(
    variant: str,
    max_duration: int,
    max_bytes: int,
    direct_summary_max_seconds: int = 0,
) -> None:
    if variant not in SUPPORTED_VARIANTS:
        raise WorkerFailure(
            "INVALID_LIMIT",
            "下载用途只支持 preview 或 analysis。",
            False,
        )
    if not 1 <= max_duration <= 3_600:
        raise WorkerFailure("INVALID_LIMIT", "时长限制无效。", False)
    maximum_bytes = (
        ANALYSIS_MAX_BYTES if variant == "analysis" else PREVIEW_MAX_BYTES
    )
    if not 1 <= max_bytes <= maximum_bytes:
        raise WorkerFailure("INVALID_LIMIT", "文件限制无效。", False)
    if not 0 <= direct_summary_max_seconds <= 900:
        raise WorkerFailure("INVALID_LIMIT", "Qwen 直接总结时长限制无效。", False)


def run(args: argparse.Namespace) -> None:
    if args.source_kind != "bilibili":
        run_uploaded_media(args)
        return
    if not isinstance(args.bvid, str) or not BVID_RE.fullmatch(args.bvid):
        raise WorkerFailure("INVALID_BVID", "BVID 格式无效。", False)
    validate_runtime_limits(
        args.variant,
        args.max_duration,
        args.max_bytes,
        args.direct_summary_max_seconds,
    )
    state_root = Path(args.state_root)
    job_dir = resolve_job_dir(state_root, args.job_id)
    ffmpeg_location, ffprobe = locate_ffmpeg()
    reporter = ProgressReporter(job_dir, args.max_bytes)
    url = f"https://www.bilibili.com/video/{args.bvid}"
    output_template = str(job_dir / "artifact.%(ext)s")

    try:
        import yt_dlp
        from yt_dlp.utils import DownloadError
    except ImportError as exc:
        raise WorkerFailure(
            "DEPENDENCY_MISSING", "服务器未安装 yt-dlp。", False
        ) from exc

    options: dict[str, Any] = {
        "ignoreconfig": True,
        "noplaylist": True,
        "playlist_items": "1",
        "format": browser_compatible_format(args.variant),
        "format_sort": [
            "vcodec:h264",
            "acodec:aac",
            "ext:mp4:m4a",
        ],
        "merge_output_format": "mp4",
        "outtmpl": output_template,
        "ffmpeg_location": ffmpeg_location,
        "max_filesize": args.max_bytes,
        "overwrites": False,
        "continuedl": True,
        "quiet": True,
        "no_warnings": True,
        "noprogress": True,
        "logger": QuietLogger(),
        "progress_hooks": [reporter.download_hook],
        "postprocessor_hooks": [reporter.postprocessor_hook],
        "postprocessors": [
            {"key": "FFmpegVideoRemuxer", "preferedformat": "mp4"}
        ],
        "concurrent_fragment_downloads": DOWNLOAD_FRAGMENT_CONCURRENCY,
        "cachedir": False,
        "usenetrc": False,
        "cookiefile": None,
        "cookiesfrombrowser": None,
        "writethumbnail": False,
        "writesubtitles": False,
        "writeautomaticsub": False,
        "writeinfojson": False,
        **download_network_options(),
    }

    emit("progress", phase="resolving", progress=0.02)
    resolving = True
    try:
        with yt_dlp.YoutubeDL(options) as downloader:
            info = downloader.extract_info(url, download=False)
            if not isinstance(info, dict):
                raise WorkerFailure("METADATA_FAILED", "B 站视频信息无效。", True)
            title, duration, description = validate_video_info(
                info, args.max_duration, args.max_bytes
            )
            emit(
                "source",
                title=title,
                durationSeconds=round(duration, 3),
                description=description,
            )
            emit("progress", phase="downloading", progress=0.08)
            resolving = False
            downloader.process_ie_result(info, download=True)
    except WorkerFailure:
        raise
    except DownloadError as exc:
        if reporter.limit_exceeded:
            raise WorkerFailure(
                "VIDEO_TOO_LARGE", "下载内容超过媒体服务大小限制。", False
            ) from exc
        raise classify_download_error(str(exc), resolving) from exc
    except Exception as exc:
        if reporter.limit_exceeded:
            raise WorkerFailure(
                "VIDEO_TOO_LARGE", "下载内容超过媒体服务大小限制。", False
            ) from exc
        raise classify_download_error(str(exc), resolving) from exc

    emit("progress", phase="merging", progress=0.94)
    artifact = find_artifact(job_dir)
    size, sha256, width, height = verify_artifact(
        ffprobe, artifact, args.max_duration, args.max_bytes
    )
    if args.variant == "analysis":
        build_and_emit_analysis(args, artifact, job_dir, duration)
    mime_type = mimetypes.guess_type(artifact.name)[0] or "video/mp4"
    if not mime_type.startswith("video/"):
        mime_type = "video/mp4"
    filename = safe_download_filename(title, args.bvid, artifact.suffix)
    emit(
        "artifact",
        artifactFile=artifact.name,
        filename=filename,
        mimeType=mime_type,
        sizeBytes=size,
        sha256=sha256,
        width=width,
        height=height,
    )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(add_help=False, allow_abbrev=False)
    parser.add_argument("--state-root", required=True)
    parser.add_argument("--job-id", required=True)
    parser.add_argument(
        "--source-kind",
        default="bilibili",
        choices=("upload", "bilibili", "url"),
    )
    parser.add_argument("--source-name", default="video")
    parser.add_argument("--source-url")
    parser.add_argument("--input-file")
    parser.add_argument("--bvid")
    parser.add_argument("--variant", required=True, choices=sorted(SUPPORTED_VARIANTS))
    parser.add_argument("--max-duration", required=True, type=int)
    parser.add_argument("--max-bytes", required=True, type=int)
    parser.add_argument(
        "--direct-summary-max-seconds",
        default=0,
        type=int,
    )
    return parser.parse_args()


def main() -> int:
    try:
        run(parse_args())
        return 0
    except WorkerFailure as exc:
        emit(
            "error",
            code=exc.code,
            message=exc.message,
            retryable=exc.retryable,
        )
        return 1
    except Exception:
        emit(
            "error",
            code="INTERNAL_ERROR",
            message="下载进程发生内部错误。",
            retryable=True,
        )
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
