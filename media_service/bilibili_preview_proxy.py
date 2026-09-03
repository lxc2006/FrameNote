from __future__ import annotations

import os
import re
import secrets
import threading
import time
from dataclasses import dataclass
from typing import Literal

import httpx

from .bilibili_preview import BilibiliPreviewTrack, ResolvedBilibiliPreview


PREVIEW_SESSION_TTL_SECONDS = 6 * 60 * 60
MAX_PREVIEW_SESSIONS = 256
_SESSION_ID_RE = re.compile(r"^[A-Za-z0-9_-]{32,128}$", re.ASCII)
_SINGLE_RANGE_RE = re.compile(r"^bytes=(?:[0-9]+-[0-9]*|-[0-9]+)$", re.ASCII)
_RESPONSE_HEADERS = {
    "accept-ranges",
    "content-length",
    "content-range",
    "content-type",
    "etag",
    "last-modified",
}


class BilibiliPreviewProxyError(RuntimeError):
    def __init__(self, status_code: int, code: str, message: str) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.code = code
        self.message = message


@dataclass(frozen=True, slots=True)
class BilibiliPreviewSession:
    session_id: str
    video_track: BilibiliPreviewTrack
    audio_track: BilibiliPreviewTrack | None
    expires_at: float


@dataclass(slots=True)
class OpenedBilibiliPreviewStream:
    client: httpx.AsyncClient
    response: httpx.Response
    media_type: str

    async def close(self) -> None:
        await self.response.aclose()
        await self.client.aclose()

    def response_headers(self) -> dict[str, str]:
        headers = {
            name: value
            for name, value in self.response.headers.items()
            if name.lower() in _RESPONSE_HEADERS
        }
        headers.setdefault("accept-ranges", "bytes")
        headers.setdefault("content-type", self.media_type)
        headers["cache-control"] = "private, no-store"
        headers["content-disposition"] = "inline"
        return headers


class BilibiliPreviewSessionStore:
    def __init__(
        self,
        *,
        ttl_seconds: int = PREVIEW_SESSION_TTL_SECONDS,
        max_sessions: int = MAX_PREVIEW_SESSIONS,
    ) -> None:
        self._ttl_seconds = ttl_seconds
        self._max_sessions = max_sessions
        self._sessions: dict[str, BilibiliPreviewSession] = {}
        self._lock = threading.Lock()

    def create(self, preview: ResolvedBilibiliPreview) -> BilibiliPreviewSession:
        now = time.time()
        session = BilibiliPreviewSession(
            session_id=secrets.token_urlsafe(32),
            video_track=preview.video_track,
            audio_track=preview.audio_track,
            expires_at=now + self._ttl_seconds,
        )
        with self._lock:
            self._remove_expired(now)
            while len(self._sessions) >= self._max_sessions:
                oldest_id = min(
                    self._sessions,
                    key=lambda session_id: self._sessions[session_id].expires_at,
                )
                del self._sessions[oldest_id]
            self._sessions[session.session_id] = session
        return session

    def track(
        self,
        session_id: str,
        kind: Literal["video", "audio"],
    ) -> BilibiliPreviewTrack:
        if not _SESSION_ID_RE.fullmatch(session_id):
            raise BilibiliPreviewProxyError(
                404,
                "BILIBILI_PREVIEW_NOT_FOUND",
                "视频预览会话不存在或已经失效。",
            )
        now = time.time()
        with self._lock:
            self._remove_expired(now)
            session = self._sessions.get(session_id)
        if session is None:
            raise BilibiliPreviewProxyError(
                404,
                "BILIBILI_PREVIEW_NOT_FOUND",
                "视频预览会话不存在或已经失效。",
            )
        track = session.video_track if kind == "video" else session.audio_track
        if track is None:
            raise BilibiliPreviewProxyError(
                404,
                "BILIBILI_PREVIEW_TRACK_NOT_FOUND",
                "这个视频没有独立的音频预览轨。",
            )
        return track

    def _remove_expired(self, now: float) -> None:
        expired = [
            session_id
            for session_id, session in self._sessions.items()
            if session.expires_at <= now
        ]
        for session_id in expired:
            del self._sessions[session_id]


def validate_range_header(value: str | None) -> str | None:
    if value is None:
        return None
    normalized = value.strip()
    if not _SINGLE_RANGE_RE.fullmatch(normalized):
        raise BilibiliPreviewProxyError(
            416,
            "BILIBILI_PREVIEW_RANGE_INVALID",
            "视频预览只支持单段字节范围请求。",
        )
    return normalized


async def open_bilibili_preview_stream(
    track: BilibiliPreviewTrack,
    range_header: str | None,
) -> OpenedBilibiliPreviewStream:
    headers = track.request_headers()
    headers["accept-encoding"] = "identity"
    normalized_range = validate_range_header(range_header)
    if normalized_range:
        headers["range"] = normalized_range

    client_options: dict[str, object] = {
        "follow_redirects": True,
        "timeout": httpx.Timeout(60.0, connect=15.0),
    }
    proxy = os.getenv("FRAMENOTE_MEDIA_PROXY", "").strip()
    if proxy:
        client_options["proxy"] = proxy
    client = httpx.AsyncClient(**client_options)
    last_status: int | None = None
    try:
        for url in track.urls:
            try:
                request = client.build_request("GET", url, headers=headers)
                response = await client.send(request, stream=True)
            except httpx.TransportError:
                continue
            if response.status_code in {200, 206}:
                return OpenedBilibiliPreviewStream(
                    client=client,
                    response=response,
                    media_type=track.media_type,
                )
            last_status = response.status_code
            await response.aclose()
    except BaseException:
        await client.aclose()
        raise

    await client.aclose()
    if last_status == 416:
        raise BilibiliPreviewProxyError(
            416,
            "BILIBILI_PREVIEW_RANGE_UNSATISFIABLE",
            "请求的视频字节范围超出了媒体长度。",
        )
    raise BilibiliPreviewProxyError(
        502,
        "BILIBILI_PREVIEW_CDN_FAILED",
        "B站 CDN 拒绝或中断了视频预览请求，请重新获取视频。",
    )
