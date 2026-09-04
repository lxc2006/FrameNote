from __future__ import annotations

import unittest
from unittest.mock import AsyncMock, patch

import httpx
from starlette.requests import Request

from media_service.bilibili_preview import (
    BilibiliPreviewTrack,
    ResolvedBilibiliPreview,
)
from media_service.bilibili_preview_proxy import (
    BilibiliPreviewProxyError,
    BilibiliPreviewSessionStore,
    open_bilibili_preview_stream,
    validate_range_header,
)
from media_service.main import resolve_bilibili_video_preview
from media_service.service.models import BilibiliPreviewRequest


def _track(*urls: str) -> BilibiliPreviewTrack:
    return BilibiliPreviewTrack(
        urls=urls,
        headers=(
            ("referer", "https://www.bilibili.com/video/BV1nx411u79K/"),
            ("user-agent", "FrameNote test browser"),
        ),
        media_type="video/mp4",
    )


class BilibiliPreviewSessionStoreTests(unittest.TestCase):
    def test_session_hides_upstream_urls_behind_an_opaque_token(self) -> None:
        video_track = _track("https://cdn.example/video.m4s")
        preview = ResolvedBilibiliPreview(
            video_track=video_track,
            audio_track=None,
            bvid="BV1nx411u79K",
            title="Preview",
            description=None,
            duration_seconds=60,
            size_bytes=100,
            width=1920,
            height=1080,
            filename="preview.mp4",
        )
        store = BilibiliPreviewSessionStore(ttl_seconds=60, max_sessions=2)

        session = store.create(preview)

        self.assertGreaterEqual(len(session.session_id), 32)
        self.assertEqual(store.track(session.session_id, "video"), video_track)
        with self.assertRaises(BilibiliPreviewProxyError):
            store.track(session.session_id, "audio")

    def test_rejects_invalid_range_headers(self) -> None:
        self.assertEqual(validate_range_header("bytes=0-1023"), "bytes=0-1023")
        self.assertEqual(validate_range_header("bytes=-1024"), "bytes=-1024")
        with self.assertRaises(BilibiliPreviewProxyError):
            validate_range_header("bytes=0-1,4-5")


class BilibiliPreviewUpstreamTests(unittest.IsolatedAsyncioTestCase):
    async def test_preview_endpoint_returns_local_proxy_urls(self) -> None:
        video_track = _track("https://cdn.example/video.m4s")
        audio_track = BilibiliPreviewTrack(
            urls=("https://cdn.example/audio.m4s",),
            headers=video_track.headers,
            media_type="audio/mp4",
        )
        preview = ResolvedBilibiliPreview(
            video_track=video_track,
            audio_track=audio_track,
            bvid="BV1nx411u79K",
            title="Preview",
            description=None,
            duration_seconds=60,
            size_bytes=100,
            width=1920,
            height=1080,
            filename="preview.mp4",
        )
        request = Request(
            {
                "type": "http",
                "scheme": "http",
                "server": ("127.0.0.1", 8788),
                "path": "/v1/bilibili/preview",
                "root_path": "",
                "query_string": b"",
                "headers": [],
            }
        )
        store = BilibiliPreviewSessionStore()
        with (
            patch(
                "media_service.main.resolve_bilibili_preview",
                new=AsyncMock(return_value=preview),
            ),
            patch(
                "media_service.main.get_public_base_url",
                return_value="http://127.0.0.1:8788",
            ),
        ):
            response = await resolve_bilibili_video_preview(
                BilibiliPreviewRequest(bvid="BV1nx411u79K"),
                request,
                store,
            )

        self.assertRegex(
            response.playbackUrl,
            r"^http://127\.0\.0\.1:8788/v1/bilibili/preview/[^/]+/video$",
        )
        self.assertRegex(response.audioPlaybackUrl or "", r"/[^/]+/audio$")
        self.assertNotIn("cdn.example", response.playbackUrl)

    async def test_injects_referer_and_forwards_range_and_response_headers(self) -> None:
        requests: list[httpx.Request] = []

        def handler(request: httpx.Request) -> httpx.Response:
            requests.append(request)
            return httpx.Response(
                206,
                headers={
                    "content-type": "video/mp4",
                    "content-range": "bytes 0-2/9",
                    "content-length": "3",
                    "accept-ranges": "bytes",
                },
                content=b"abc",
            )

        transport = httpx.MockTransport(handler)
        async_client = httpx.AsyncClient
        with patch(
            "media_service.bilibili_preview_proxy.httpx.AsyncClient",
            side_effect=lambda **_kwargs: async_client(transport=transport),
        ):
            opened = await open_bilibili_preview_stream(
                _track("https://cdn.example/video.m4s"),
                "bytes=0-2",
            )
        try:
            self.assertEqual(await opened.response.aread(), b"abc")
            self.assertEqual(opened.response.status_code, 206)
            self.assertEqual(
                requests[0].headers["referer"],
                "https://www.bilibili.com/video/BV1nx411u79K/",
            )
            self.assertEqual(requests[0].headers["range"], "bytes=0-2")
            self.assertEqual(requests[0].headers["accept-encoding"], "identity")
            self.assertEqual(
                opened.response_headers()["content-range"],
                "bytes 0-2/9",
            )
        finally:
            await opened.close()

    async def test_tries_a_backup_cdn_after_a_rejected_primary_url(self) -> None:
        requested_hosts: list[str] = []

        def handler(request: httpx.Request) -> httpx.Response:
            requested_hosts.append(request.url.host)
            if request.url.host == "primary.example":
                return httpx.Response(403)
            return httpx.Response(206, content=b"ok")

        transport = httpx.MockTransport(handler)
        async_client = httpx.AsyncClient
        with patch(
            "media_service.bilibili_preview_proxy.httpx.AsyncClient",
            side_effect=lambda **_kwargs: async_client(transport=transport),
        ):
            opened = await open_bilibili_preview_stream(
                _track(
                    "https://primary.example/video.m4s",
                    "https://backup.example/video.m4s",
                ),
                None,
            )
        try:
            self.assertEqual(await opened.response.aread(), b"ok")
            self.assertEqual(requested_hosts, ["primary.example", "backup.example"])
        finally:
            await opened.close()


if __name__ == "__main__":
    unittest.main()
