from __future__ import annotations

import asyncio
import logging
import math
import os
from dataclasses import dataclass
from typing import Any, Mapping
from urllib.parse import urlsplit

from .bilibili_retry import (
    BILIBILI_RESOLVE_ATTEMPTS,
    resolve_bilibili_with_retries,
)


MAX_PREVIEW_QUALITY = 1080
DEFAULT_BROWSER_USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/138.0.0.0 Safari/537.36"
)
_FORWARDED_HEADER_NAMES = {
    "accept",
    "accept-language",
    "origin",
    "referer",
    "user-agent",
}
LOGGER = logging.getLogger("media_service.bilibili_preview")


class _PreviewYtDlpLogger:
    """Keep retryable yt-dlp failures quiet until extraction finally fails."""

    def __init__(self) -> None:
        self.last_error: str | None = None

    def debug(self, _message: str) -> None:
        pass

    def warning(self, message: str) -> None:
        LOGGER.debug("yt-dlp preview warning: %s", message)

    def error(self, message: str) -> None:
        self.last_error = message


class BilibiliPreviewError(RuntimeError):
    def __init__(self, code: str, message: str, retryable: bool = True) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.retryable = retryable


@dataclass(frozen=True, slots=True)
class BilibiliPreviewTrack:
    urls: tuple[str, ...]
    headers: tuple[tuple[str, str], ...]
    media_type: str
    cookies: tuple[tuple[str, str, str, str], ...] = ()

    @property
    def primary_url(self) -> str:
        return self.urls[0]

    def request_headers(self) -> dict[str, str]:
        return dict(self.headers)


@dataclass(frozen=True, slots=True)
class ResolvedBilibiliPreview:
    video_track: BilibiliPreviewTrack
    audio_track: BilibiliPreviewTrack | None
    bvid: str
    title: str
    description: str | None
    duration_seconds: float
    size_bytes: int
    width: int | None
    height: int | None
    filename: str

    @property
    def playback_url(self) -> str:
        return self.video_track.primary_url

    @property
    def audio_playback_url(self) -> str | None:
        return self.audio_track.primary_url if self.audio_track else None


async def resolve_bilibili_preview(bvid: str) -> ResolvedBilibiliPreview:
    return await asyncio.to_thread(_resolve_bilibili_preview_sync, bvid)


def _resolve_bilibili_preview_sync(bvid: str) -> ResolvedBilibiliPreview:
    try:
        import yt_dlp
        from yt_dlp.utils import DownloadError
    except ImportError as exc:
        raise BilibiliPreviewError(
            "DEPENDENCY_MISSING",
            "媒体服务没有安装 yt-dlp。",
            False,
        ) from exc

    preview_logger = _PreviewYtDlpLogger()
    options: dict[str, Any] = {
        "ignoreconfig": True,
        "quiet": True,
        "no_warnings": True,
        "skip_download": True,
        "noplaylist": True,
        "socket_timeout": 20,
        # Complete extraction retries below replace the old yt-dlp knobs, which
        # did not retry Bilibili webpage/API HTTP 412 failures.
        "retries": 0,
        "extractor_retries": 0,
        "fragment_retries": 0,
        "logger": preview_logger,
    }
    proxy = os.getenv("FRAMENOTE_MEDIA_PROXY", "").strip()
    if proxy:
        options["proxy"] = proxy

    try:
        with yt_dlp.YoutubeDL(options) as downloader:
            raw_info = resolve_bilibili_with_retries(
                lambda: downloader.extract_info(
                    f"https://www.bilibili.com/video/{bvid}",
                    download=False,
                ),
                (DownloadError, OSError),
                on_retry=lambda attempt, total, delay, _error: LOGGER.debug(
                    "Bilibili preview attempt %s/%s failed; retrying in %.1fs",
                    attempt,
                    total,
                    delay,
                ),
            )
    except DownloadError as exc:
        error_detail = preview_logger.last_error or str(exc)
        LOGGER.error(
            "Bilibili preview failed after %s attempts: %s",
            BILIBILI_RESOLVE_ATTEMPTS,
            error_detail,
        )
        is_precondition_failure = "HTTP Error 412" in error_detail
        raise BilibiliPreviewError(
            (
                "BILIBILI_RATE_LIMITED"
                if is_precondition_failure
                else "BILIBILI_RESOLVE_FAILED"
            ),
            (
                f"B站连续 {BILIBILI_RESOLVE_ATTEMPTS} 次拒绝了视频解析请求，请稍后重试或更换网络。"
                if is_precondition_failure
                else f"连续 {BILIBILI_RESOLVE_ATTEMPTS} 次无法解析这个 B站视频，请稍后重试。"
            ),
        ) from exc
    except OSError as exc:
        LOGGER.error(
            "Bilibili preview failed after %s attempts: %s",
            BILIBILI_RESOLVE_ATTEMPTS,
            exc,
        )
        raise BilibiliPreviewError(
            "BILIBILI_NETWORK_ERROR",
            f"连续 {BILIBILI_RESOLVE_ATTEMPTS} 次连接 B站失败，请检查媒体服务网络。",
        ) from exc

    info = _first_video_info(raw_info)
    formats = info.get("formats")
    if not isinstance(formats, list):
        raise BilibiliPreviewError(
            "BILIBILI_FORMATS_MISSING",
            "yt-dlp 没有返回可播放的视频格式。",
        )

    video_format = _select_video_format(formats)
    if video_format is None:
        raise BilibiliPreviewError(
            "BILIBILI_PLAYBACK_URL_MISSING",
            "没有找到不超过 1080p 且浏览器可播放的 B 站视频轨。",
        )

    has_embedded_audio = _has_codec(video_format.get("acodec"))
    audio_format = None if has_embedded_audio else _select_audio_format(formats)
    if not has_embedded_audio and audio_format is None:
        raise BilibiliPreviewError(
            "BILIBILI_AUDIO_URL_MISSING",
            "已经找到视频轨，但没有找到可播放的 B 站音频轨。",
        )

    duration = _positive_number(info.get("duration"))
    if duration is None:
        raise BilibiliPreviewError(
            "BILIBILI_METADATA_INVALID",
            "yt-dlp 没有返回有效的视频时长。",
        )

    title = (str(info.get("title") or bvid).strip() or bvid)[:1_000]
    description_value = info.get("description")
    description = (
        description_value.strip()[:20_000]
        if isinstance(description_value, str) and description_value.strip()
        else None
    )
    width = _positive_int(video_format.get("width"))
    height = _positive_int(video_format.get("height"))
    size_bytes = _format_size(video_format) + (
        _format_size(audio_format) if audio_format is not None else 0
    )

    return ResolvedBilibiliPreview(
        video_track=_preview_track(info, video_format, bvid, "video/mp4"),
        audio_track=(
            _preview_track(info, audio_format, bvid, "audio/mp4")
            if audio_format is not None
            else None
        ),
        bvid=bvid,
        title=title,
        description=description,
        duration_seconds=duration,
        size_bytes=size_bytes,
        width=width,
        height=height,
        filename=f"{bvid}.mp4",
    )


def _preview_track(
    info: Mapping[str, Any],
    media_format: Mapping[str, Any],
    bvid: str,
    fallback_media_type: str,
) -> BilibiliPreviewTrack:
    extension = str(media_format.get("ext") or "").lower()
    media_type = (
        "video/webm"
        if fallback_media_type.startswith("video/") and extension == "webm"
        else "audio/webm"
        if fallback_media_type.startswith("audio/") and extension == "webm"
        else fallback_media_type
    )
    return BilibiliPreviewTrack(
        urls=_format_urls(media_format),
        headers=tuple(_media_headers(info, media_format, bvid).items()),
        media_type=media_type,
    )


def _format_urls(media_format: Mapping[str, Any]) -> tuple[str, ...]:
    candidates: list[Any] = [media_format.get("url")]
    for key in ("backup_url", "backup_urls", "urls"):
        value = media_format.get(key)
        if isinstance(value, str):
            candidates.append(value)
        elif isinstance(value, (list, tuple)):
            candidates.extend(value)

    urls: list[str] = []
    for candidate in candidates:
        if not _is_http_url(candidate):
            continue
        url = str(candidate)
        if url not in urls:
            urls.append(url)
    if not urls:
        _required_http_url(media_format.get("url"))
    return tuple(urls)


def _media_headers(
    info: Mapping[str, Any],
    media_format: Mapping[str, Any],
    bvid: str,
) -> dict[str, str]:
    headers: dict[str, str] = {}
    for source in (info.get("http_headers"), media_format.get("http_headers")):
        if not isinstance(source, Mapping):
            continue
        for raw_name, raw_value in source.items():
            if not isinstance(raw_name, str) or not isinstance(raw_value, str):
                continue
            name = raw_name.strip()
            value = raw_value.strip()
            if name.lower() not in _FORWARDED_HEADER_NAMES or not value:
                continue
            headers[name.lower()] = value

    if "referer" not in headers:
        headers["referer"] = f"https://www.bilibili.com/video/{bvid}/"
    if "user-agent" not in headers:
        headers["user-agent"] = DEFAULT_BROWSER_USER_AGENT
    if "accept" not in headers:
        headers["accept"] = "*/*"
    return headers


def _first_video_info(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise BilibiliPreviewError(
            "BILIBILI_METADATA_INVALID",
            "yt-dlp 返回了无效的视频信息。",
        )
    entries = value.get("entries")
    if isinstance(entries, list):
        for entry in entries:
            if isinstance(entry, dict):
                return entry
        raise BilibiliPreviewError(
            "BILIBILI_METADATA_INVALID",
            "B 站合集没有可用的视频分集。",
        )
    return value


def _select_video_format(formats: list[Any]) -> dict[str, Any] | None:
    candidates = [
        item
        for item in formats
        if isinstance(item, dict)
        and _has_codec(item.get("vcodec"))
        and _is_http_url(item.get("url"))
        and 0 < _quality_edge(item) <= MAX_PREVIEW_QUALITY
    ]
    if not candidates:
        return None
    return max(candidates, key=_video_score)


def _select_audio_format(formats: list[Any]) -> dict[str, Any] | None:
    candidates = [
        item
        for item in formats
        if isinstance(item, dict)
        and not _has_codec(item.get("vcodec"))
        and _has_codec(item.get("acodec"))
        and _is_http_url(item.get("url"))
    ]
    if not candidates:
        return None
    return max(candidates, key=_audio_score)


def _video_score(item: dict[str, Any]) -> tuple[float, int, float, float]:
    codec = str(item.get("vcodec") or "").lower()
    compatibility = (
        4
        if codec.startswith(("avc", "h264"))
        else 3
        if codec.startswith(("vp9", "vp09"))
        else 2
        if codec.startswith("av01")
        else 1
    )
    return (
        _quality_edge(item),
        compatibility,
        _positive_number(item.get("fps")) or 0,
        _positive_number(item.get("tbr")) or 0,
    )


def _audio_score(item: dict[str, Any]) -> tuple[int, float, int]:
    codec = str(item.get("acodec") or "").lower()
    extension = str(item.get("ext") or "").lower()
    compatibility = 2 if codec.startswith("mp4a") or extension in {"m4a", "mp4"} else 1
    return (
        compatibility,
        _positive_number(item.get("abr"))
        or _positive_number(item.get("tbr"))
        or 0,
        _format_size(item),
    )


def _quality_edge(item: dict[str, Any]) -> float:
    width = _positive_number(item.get("width"))
    height = _positive_number(item.get("height"))
    if width is not None and height is not None:
        return min(width, height)
    return height or width or 0


def _format_size(item: dict[str, Any] | None) -> int:
    if item is None:
        return 0
    return (
        _positive_int(item.get("filesize"))
        or _positive_int(item.get("filesize_approx"))
        or 0
    )


def _has_codec(value: Any) -> bool:
    return isinstance(value, str) and value.lower() not in {"", "none"}


def _positive_number(value: Any) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    number = float(value)
    return number if math.isfinite(number) and number > 0 else None


def _positive_int(value: Any) -> int | None:
    number = _positive_number(value)
    return int(number) if number is not None else None


def _is_http_url(value: Any) -> bool:
    if not isinstance(value, str) or len(value) > 16_384:
        return False
    parsed = urlsplit(value)
    return (
        parsed.scheme in {"http", "https"}
        and bool(parsed.hostname)
        and parsed.username is None
        and parsed.password is None
    )


def _required_http_url(value: Any) -> str:
    if not _is_http_url(value):
        raise BilibiliPreviewError(
            "BILIBILI_PLAYBACK_URL_INVALID",
            "yt-dlp 返回了无效的 B 站 CDN 地址。",
        )
    return value
