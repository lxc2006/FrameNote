from __future__ import annotations

import asyncio
import logging
import math
import os
import time
from dataclasses import dataclass
from typing import Any, Mapping
from urllib.parse import urlsplit

from .bilibili_preview import BilibiliPreviewTrack


DOUYIN_RESOLVE_ATTEMPTS = 5
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
LOGGER = logging.getLogger("media_service.douyin_preview")


class _QuietYtDlpLogger:
    def __init__(self) -> None:
        self.last_error: str | None = None

    def debug(self, _message: str) -> None:
        pass

    def warning(self, message: str) -> None:
        LOGGER.debug("yt-dlp Douyin preview warning: %s", message)

    def error(self, message: str) -> None:
        self.last_error = message


class DouyinPreviewError(RuntimeError):
    def __init__(self, code: str, message: str, retryable: bool = True) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.retryable = retryable


@dataclass(frozen=True, slots=True)
class ResolvedDouyinPreview:
    video_track: BilibiliPreviewTrack
    audio_track: None
    source_url: str
    video_id: str
    title: str
    description: str | None
    duration_seconds: float
    size_bytes: int
    width: int | None
    height: int | None
    filename: str


def is_douyin_url(value: str) -> bool:
    if not isinstance(value, str) or len(value) > 2_048:
        return False
    parsed = urlsplit(value.strip())
    hostname = (parsed.hostname or "").lower().rstrip(".")
    return (
        parsed.scheme == "https"
        and parsed.username is None
        and parsed.password is None
        and (hostname == "douyin.com" or hostname.endswith(".douyin.com"))
    )


async def resolve_douyin_preview(source_url: str) -> ResolvedDouyinPreview:
    if not is_douyin_url(source_url):
        raise DouyinPreviewError(
            "INVALID_DOUYIN_URL",
            "请输入有效的抖音分享链接。",
            False,
        )
    return await asyncio.to_thread(_resolve_douyin_preview_sync, source_url.strip())


def _resolve_douyin_preview_sync(source_url: str) -> ResolvedDouyinPreview:
    try:
        import yt_dlp
        from yt_dlp.utils import DownloadError
    except ImportError as exc:
        raise DouyinPreviewError(
            "DEPENDENCY_MISSING",
            "媒体服务没有安装 yt-dlp。",
            False,
        ) from exc

    logger = _QuietYtDlpLogger()
    options: dict[str, Any] = {
        "ignoreconfig": True,
        "quiet": True,
        "no_warnings": True,
        "skip_download": True,
        "noplaylist": True,
        "socket_timeout": 20,
        "retries": 0,
        "extractor_retries": 0,
        "fragment_retries": 0,
        "cachedir": False,
        "usenetrc": False,
        "cookiesfrombrowser": None,
        "http_headers": {
            "Referer": "https://www.douyin.com/",
            "User-Agent": DEFAULT_BROWSER_USER_AGENT,
        },
        "logger": logger,
    }
    cookie_file = os.getenv("FRAMENOTE_DOUYIN_COOKIE_FILE", "").strip()
    if cookie_file and os.path.isfile(cookie_file):
        options["cookiefile"] = cookie_file
    proxy = os.getenv("FRAMENOTE_MEDIA_PROXY", "").strip()
    if proxy:
        options["proxy"] = proxy

    try:
        preview_cookies: tuple[tuple[str, str, str, str], ...] = ()
        with yt_dlp.YoutubeDL(options) as downloader:
            raw_info: Any = None
            for attempt in range(1, DOUYIN_RESOLVE_ATTEMPTS + 1):
                try:
                    raw_info = downloader.extract_info(source_url, download=False)
                    break
                except (DownloadError, OSError):
                    if attempt >= DOUYIN_RESOLVE_ATTEMPTS:
                        raise
                    LOGGER.debug(
                        "Douyin preview attempt %s/%s failed; retrying in 2 seconds",
                        attempt,
                        DOUYIN_RESOLVE_ATTEMPTS,
                    )
                    time.sleep(2)
            preview_cookies = _douyin_cookies(downloader.cookiejar)
    except DownloadError as exc:
        detail = logger.last_error or str(exc)
        LOGGER.error(
            "Douyin preview failed after %s attempts: %s",
            DOUYIN_RESOLVE_ATTEMPTS,
            detail,
        )
        lowered = detail.lower()
        restricted = any(
            marker in lowered
            for marker in (
                "fresh cookies",
                "login required",
                "private video",
                "captcha",
                "verification",
            )
        )
        raise DouyinPreviewError(
            "DOUYIN_ACCESS_RESTRICTED" if restricted else "DOUYIN_RESOLVE_FAILED",
            (
                "抖音匿名会话仍被要求验证，请稍后重试。"
                if restricted
                else f"连续 {DOUYIN_RESOLVE_ATTEMPTS} 次无法解析这个抖音视频，请稍后重试。"
            ),
            not restricted,
        ) from exc
    except OSError as exc:
        LOGGER.error("Douyin preview network failure: %s", exc)
        raise DouyinPreviewError(
            "DOUYIN_NETWORK_ERROR",
            "连接抖音失败，请检查网络后重试。",
        ) from exc

    info = _first_video_info(raw_info)
    formats = info.get("formats")
    if not isinstance(formats, list):
        raise DouyinPreviewError(
            "DOUYIN_FORMATS_MISSING",
            "yt-dlp 没有返回可播放的抖音视频格式。",
        )
    video_format = _select_progressive_format(formats)
    if video_format is None:
        raise DouyinPreviewError(
            "DOUYIN_PLAYBACK_URL_MISSING",
            "没有找到同时包含画面和声音的抖音视频流。",
        )

    duration = _positive_number(info.get("duration"))
    if duration is None:
        raise DouyinPreviewError(
            "DOUYIN_METADATA_INVALID",
            "yt-dlp 没有返回有效的抖音视频时长。",
        )
    video_id = str(info.get("id") or "video").strip()[:128] or "video"
    title = str(info.get("title") or f"抖音视频 {video_id}").strip()[:1_000]
    description_value = info.get("description")
    description = (
        description_value.strip()[:20_000]
        if isinstance(description_value, str) and description_value.strip()
        else None
    )
    canonical_url_value = info.get("webpage_url")
    canonical_url = (
        canonical_url_value.strip()
        if isinstance(canonical_url_value, str) and is_douyin_url(canonical_url_value)
        else source_url
    )
    width = _positive_int(video_format.get("width"))
    height = _positive_int(video_format.get("height"))
    size_bytes = _positive_int(video_format.get("filesize")) or _positive_int(
        video_format.get("filesize_approx")
    ) or 0
    return ResolvedDouyinPreview(
        video_track=_preview_track(
            info,
            video_format,
            source_url,
            preview_cookies,
        ),
        audio_track=None,
        source_url=canonical_url,
        video_id=video_id,
        title=title,
        description=description,
        duration_seconds=duration,
        size_bytes=size_bytes,
        width=width,
        height=height,
        filename=f"douyin-{video_id}.mp4",
    )


def _first_video_info(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise DouyinPreviewError("DOUYIN_METADATA_INVALID", "抖音视频信息无效。")
    entries = value.get("entries")
    if isinstance(entries, list):
        for entry in entries:
            if isinstance(entry, dict):
                return entry
        raise DouyinPreviewError("DOUYIN_METADATA_INVALID", "分享链接中没有视频。")
    return value


def _select_progressive_format(formats: list[Any]) -> dict[str, Any] | None:
    candidates = [
        item
        for item in formats
        if isinstance(item, dict)
        and _has_codec(item.get("vcodec"))
        and _has_codec(item.get("acodec"))
        and str(item.get("ext") or "").lower() in {"mp4", "m4v"}
        and _is_http_url(item.get("url"))
        and (_quality_edge(item) <= MAX_PREVIEW_QUALITY or _quality_edge(item) == 0)
    ]
    if not candidates:
        return None
    return max(
        candidates,
        key=lambda item: (
            _quality_edge(item),
            _positive_number(item.get("tbr")) or 0,
            _positive_int(item.get("filesize"))
            or _positive_int(item.get("filesize_approx"))
            or 0,
        ),
    )


def _preview_track(
    info: Mapping[str, Any],
    media_format: Mapping[str, Any],
    source_url: str,
    cookies: tuple[tuple[str, str, str, str], ...],
) -> BilibiliPreviewTrack:
    urls: list[str] = []
    candidates: list[Any] = [media_format.get("url")]
    for key in ("backup_url", "backup_urls", "urls"):
        value = media_format.get(key)
        candidates.extend(value if isinstance(value, (list, tuple)) else [value])
    for candidate in candidates:
        if _is_http_url(candidate) and candidate not in urls:
            urls.append(str(candidate))
    if not urls:
        raise DouyinPreviewError(
            "DOUYIN_PLAYBACK_URL_INVALID",
            "yt-dlp 返回了无效的抖音 CDN 地址。",
        )

    headers: dict[str, str] = {}
    for source in (info.get("http_headers"), media_format.get("http_headers")):
        if not isinstance(source, Mapping):
            continue
        for raw_name, raw_value in source.items():
            if not isinstance(raw_name, str) or not isinstance(raw_value, str):
                continue
            name = raw_name.strip().lower()
            value = raw_value.strip()
            if name in _FORWARDED_HEADER_NAMES and value:
                headers[name] = value
    headers.setdefault("referer", source_url)
    headers.setdefault("user-agent", DEFAULT_BROWSER_USER_AGENT)
    headers.setdefault("accept", "*/*")
    extension = str(media_format.get("ext") or "").lower()
    media_type = "video/webm" if extension == "webm" else "video/mp4"
    return BilibiliPreviewTrack(
        urls=tuple(urls),
        headers=tuple(headers.items()),
        media_type=media_type,
        cookies=cookies,
    )


def _douyin_cookies(cookie_jar: Any) -> tuple[tuple[str, str, str, str], ...]:
    return tuple(
        (str(cookie.domain), str(cookie.path or "/"), str(cookie.name), str(cookie.value))
        for cookie in cookie_jar
        if str(cookie.domain or "").lstrip(".").lower().endswith("douyin.com")
    )


def _quality_edge(item: Mapping[str, Any]) -> float:
    width = _positive_number(item.get("width"))
    height = _positive_number(item.get("height"))
    if width is not None and height is not None:
        return min(width, height)
    return height or width or 0


def _has_codec(value: Any) -> bool:
    return isinstance(value, str) and value.lower() not in {"", "none"}


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


def _positive_number(value: Any) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    number = float(value)
    return number if math.isfinite(number) and number > 0 else None


def _positive_int(value: Any) -> int | None:
    number = _positive_number(value)
    return int(number) if number is not None else None
