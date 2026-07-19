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
SUPPORTED_MAX_HEIGHTS = frozenset({720, 1080})
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


def browser_compatible_format(max_height: int) -> str:
    return (
        rf"bv[height<={max_height}][ext=mp4][vcodec~='^(?:h264|avc[13](?:\.|$))']"
        r"+ba[ext=m4a][acodec~='^(?:aac|mp4a\.40\.)']/"
        rf"b[height<={max_height}][ext=mp4][vcodec~='^(?:h264|avc[13](?:\.|$))']"
        r"[acodec~='^(?:aac|mp4a\.40\.)']"
    )


BROWSER_COMPATIBLE_FORMAT = browser_compatible_format(720)


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
) -> tuple[str, float]:
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
    return title.strip()[:300], float(duration)


def safe_download_filename(title: str, bvid: str, suffix: str) -> str:
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
    return f"{normalized[:120].rstrip(' .')} [{bvid}]{suffix.lower()}"


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


def validate_artifact_probe(payload: dict[str, Any], max_duration: int) -> int | None:
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
    heights = [
        int(stream["height"])
        for stream in video_streams
        if isinstance(stream.get("height"), int) and stream["height"] > 0
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
    return max(heights) if heights else None


def verify_artifact(
    ffprobe: str, artifact: Path, max_duration: int, max_bytes: int
) -> tuple[int, str, int | None]:
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
        "format=format_name,duration,size:stream=codec_type,codec_name,height",
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
    height = validate_artifact_probe(payload, max_duration)
    digest = hashlib.sha256()
    with artifact.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return stat.st_size, digest.hexdigest(), height


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


def run(args: argparse.Namespace) -> None:
    if not BVID_RE.fullmatch(args.bvid):
        raise WorkerFailure("INVALID_BVID", "BVID 格式无效。", False)
    if not 1 <= args.max_duration <= 3_600:
        raise WorkerFailure("INVALID_LIMIT", "时长限制无效。", False)
    if not 1 <= args.max_bytes <= 300 * 1024 * 1024:
        raise WorkerFailure("INVALID_LIMIT", "文件限制无效。", False)
    if args.max_height not in SUPPORTED_MAX_HEIGHTS:
        raise WorkerFailure("INVALID_LIMIT", "清晰度上限只支持 720p 或 1080p。", False)
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
        "format": browser_compatible_format(args.max_height),
        "format_sort": [
            f"res:{args.max_height}",
            "vcodec:h264",
            "acodec:aac",
            "ext:mp4:m4a",
        ],
        "merge_output_format": "mp4",
        "outtmpl": output_template,
        "paths": {"home": str(job_dir), "temp": str(job_dir)},
        "ffmpeg_location": ffmpeg_location,
        "max_filesize": args.max_bytes,
        "overwrites": False,
        "continuedl": False,
        "quiet": True,
        "no_warnings": True,
        "noprogress": True,
        "logger": QuietLogger(),
        "progress_hooks": [reporter.download_hook],
        "postprocessor_hooks": [reporter.postprocessor_hook],
        "postprocessors": [
            {"key": "FFmpegVideoRemuxer", "preferedformat": "mp4"}
        ],
        "socket_timeout": 20,
        "retries": 3,
        "fragment_retries": 3,
        "file_access_retries": 3,
        "extractor_retries": 3,
        "concurrent_fragment_downloads": 2,
        "cachedir": False,
        "usenetrc": False,
        "cookiefile": None,
        "cookiesfrombrowser": None,
        "writethumbnail": False,
        "writesubtitles": False,
        "writeautomaticsub": False,
        "writeinfojson": False,
    }

    emit("progress", phase="resolving", progress=0.02)
    resolving = True
    try:
        with yt_dlp.YoutubeDL(options) as downloader:
            info = downloader.extract_info(url, download=False)
            if not isinstance(info, dict):
                raise WorkerFailure("METADATA_FAILED", "B 站视频信息无效。", True)
            title, duration = validate_video_info(
                info, args.max_duration, args.max_bytes
            )
            emit("source", title=title, durationSeconds=round(duration, 3))
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
    size, sha256, height = verify_artifact(
        ffprobe, artifact, args.max_duration, args.max_bytes
    )
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
        height=height,
    )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(add_help=False, allow_abbrev=False)
    parser.add_argument("--state-root", required=True)
    parser.add_argument("--job-id", required=True)
    parser.add_argument("--bvid", required=True)
    parser.add_argument("--max-height", required=True, type=int)
    parser.add_argument("--max-duration", required=True, type=int)
    parser.add_argument("--max-bytes", required=True, type=int)
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
