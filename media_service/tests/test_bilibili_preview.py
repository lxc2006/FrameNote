from __future__ import annotations

import unittest
from unittest.mock import patch

from media_service.bilibili_preview import (
    MAX_PREVIEW_QUALITY,
    _resolve_bilibili_preview_sync,
    _select_video_format,
)


class _FakeYoutubeDL:
    info: dict = {}

    def __init__(self, options: dict) -> None:
        self.options = options

    def __enter__(self) -> "_FakeYoutubeDL":
        return self

    def __exit__(self, *_args: object) -> None:
        return None

    def extract_info(self, url: str, *, download: bool) -> dict:
        if download:
            raise AssertionError("preview resolver must not download media")
        if not url.endswith("BV1nx411u79K"):
            raise AssertionError("resolver must use the validated BVID URL")
        return self.info


class BilibiliPreviewTests(unittest.TestCase):
    def test_prefers_browser_compatible_1080p_and_separate_m4a_audio(self) -> None:
        _FakeYoutubeDL.info = {
            "title": "公开视频",
            "description": "简介",
            "duration": 120,
            "formats": [
                {
                    "url": "https://cdn.example/4k.mp4",
                    "width": 3840,
                    "height": 2160,
                    "vcodec": "avc1.640033",
                    "acodec": "none",
                    "filesize": 400,
                },
                {
                    "url": "https://cdn.example/1080-hevc.mp4",
                    "width": 1920,
                    "height": 1080,
                    "vcodec": "hvc1.1.6.L150",
                    "acodec": "none",
                    "filesize": 80,
                },
                {
                    "url": "https://cdn.example/1080-avc.mp4",
                    "width": 1920,
                    "height": 1080,
                    "fps": 30,
                    "tbr": 1_200,
                    "vcodec": "avc1.640033",
                    "acodec": "none",
                    "filesize": 100,
                },
                {
                    "url": "https://cdn.example/audio-low.m4a",
                    "vcodec": "none",
                    "acodec": "mp4a.40.2",
                    "ext": "m4a",
                    "abr": 66,
                    "filesize": 10,
                },
                {
                    "url": "https://cdn.example/audio-high.m4a",
                    "vcodec": "none",
                    "acodec": "mp4a.40.2",
                    "ext": "m4a",
                    "abr": 166,
                    "filesize": 20,
                },
            ],
        }
        with patch("yt_dlp.YoutubeDL", _FakeYoutubeDL):
            preview = _resolve_bilibili_preview_sync("BV1nx411u79K")

        self.assertEqual(MAX_PREVIEW_QUALITY, 1080)
        self.assertEqual(preview.playback_url, "https://cdn.example/1080-avc.mp4")
        self.assertEqual(preview.audio_playback_url, "https://cdn.example/audio-high.m4a")
        self.assertEqual(preview.width, 1920)
        self.assertEqual(preview.height, 1080)
        self.assertEqual(preview.size_bytes, 120)
        self.assertEqual(
            preview.video_track.request_headers()["referer"],
            "https://www.bilibili.com/video/BV1nx411u79K/",
        )
        self.assertIn("user-agent", preview.video_track.request_headers())

    def test_uses_short_edge_as_the_1080p_ceiling_for_vertical_video(self) -> None:
        selected = _select_video_format(
            [
                {
                    "url": "https://cdn.example/vertical-1080.mp4",
                    "width": 1080,
                    "height": 1920,
                    "vcodec": "avc1.640033",
                    "acodec": "none",
                },
                {
                    "url": "https://cdn.example/vertical-4k.mp4",
                    "width": 2160,
                    "height": 3840,
                    "vcodec": "avc1.640033",
                    "acodec": "none",
                },
            ]
        )
        self.assertIsNotNone(selected)
        self.assertEqual(selected["url"], "https://cdn.example/vertical-1080.mp4")


if __name__ == "__main__":
    unittest.main()
