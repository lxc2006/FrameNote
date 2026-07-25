from __future__ import annotations

import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from yt_dlp import YoutubeDL

from media_service.worker import (
    BROWSER_COMPATIBLE_FORMAT,
    DOWNLOAD_FRAGMENT_CONCURRENCY,
    WorkerFailure,
    browser_compatible_format,
    classify_download_error,
    estimate_download_bytes,
    safe_download_filename,
    validate_artifact_probe,
    validate_video_info,
    verify_artifact,
)


class WorkerValidationTests(unittest.TestCase):
    @staticmethod
    def public_info(**values):
        return {"extractor_key": "BiliBili", "availability": "public", **values}

    @staticmethod
    def compatible_probe(**values):
        payload = {
            "format": {
                "format_name": "mov,mp4,m4a,3gp,3g2,mj2",
                "duration": "60.0",
                "size": "1024",
            },
            "streams": [
                {
                    "codec_type": "video",
                    "codec_name": "h264",
                    "width": 1280,
                    "height": 720,
                },
                {"codec_type": "audio", "codec_name": "aac"},
            ],
        }
        payload.update(values)
        return payload

    def test_downloads_four_fragments_concurrently(self) -> None:
        self.assertEqual(DOWNLOAD_FRAGMENT_CONCURRENCY, 4)

    def test_browser_format_restricts_every_fallback_to_avc_and_aac(self) -> None:
        branches = BROWSER_COMPATIBLE_FORMAT.split("/")
        self.assertEqual(len(branches), 2)
        for branch in branches:
            with self.subTest(branch=branch):
                self.assertIn("[ext=mp4]", branch)
                self.assertIn("[width<=1280]", branch)
                self.assertIn("[height<=1280]", branch)
                self.assertIn(
                    "[vcodec~='^(?:h264|avc[13](?:\\.|$))']", branch
                )
                self.assertIn(
                    "[acodec~='^(?:aac|mp4a\\.40\\.)']", branch
                )

    def test_preview_format_uses_highest_compatible_resolution(self) -> None:
        format_selector = browser_compatible_format("preview")
        branches = format_selector.split("/")
        self.assertEqual(len(branches), 2)
        for branch in branches:
            with self.subTest(branch=branch):
                self.assertNotIn("[width<=", branch)
                self.assertNotIn("[height<=", branch)
                self.assertIn(
                    "[vcodec~='^(?:h264|avc[13](?:\\.|$))']", branch
                )
                self.assertIn(
                    "[acodec~='^(?:aac|mp4a\\.40\\.)']", branch
                )

    def test_analysis_format_keeps_portrait_720_by_1280_streams(self) -> None:
        formats = [
            self.format_info(
                "portrait-852", "mp4", 852, "avc1.640033", "none", width=480
            ),
            self.format_info(
                "portrait-1280", "mp4", 1280, "avc1.640033", "none", width=720
            ),
            self.format_info(
                "portrait-1920", "mp4", 1920, "avc1.640033", "none", width=1080
            ),
            self.format_info("aac", "m4a", None, "none", "mp4a.40.2"),
        ]
        downloader = YoutubeDL({"quiet": True, "no_warnings": True})
        selected = downloader._select_formats(
            formats,
            downloader.build_format_selector(BROWSER_COMPATIBLE_FORMAT),
        )

        self.assertEqual(len(selected), 1)
        self.assertEqual(
            [item["format_id"] for item in selected[0]["requested_formats"]],
            ["portrait-1280", "aac"],
        )

    def test_browser_format_semantically_prefers_avc_and_aac(self) -> None:
        formats = [
            self.format_info("avc-720", "mp4", 720, "avc1.640033", "none"),
            self.format_info("av1-720", "mp4", 720, "av01.0.08M.08", "none"),
            self.format_info("opus", "webm", None, "none", "opus"),
            self.format_info("mp4a-mp3", "m4a", None, "none", "mp4a.69"),
            self.format_info("aac", "m4a", None, "none", "mp4a.40.2"),
        ]
        downloader = YoutubeDL({"quiet": True, "no_warnings": True})
        selected = downloader._select_formats(
            formats,
            downloader.build_format_selector(BROWSER_COMPATIBLE_FORMAT),
        )

        self.assertEqual(len(selected), 1)
        self.assertEqual(
            [item["format_id"] for item in selected[0]["requested_formats"]],
            ["avc-720", "aac"],
        )

    def test_browser_format_has_no_av1_or_opus_fallback(self) -> None:
        formats = [
            self.format_info("av1-720", "mp4", 720, "av01.0.08M.08", "none"),
            self.format_info("opus", "webm", None, "none", "opus"),
        ]
        downloader = YoutubeDL({"quiet": True, "no_warnings": True})

        self.assertEqual(
            downloader._select_formats(
                formats,
                downloader.build_format_selector(BROWSER_COMPATIBLE_FORMAT),
            ),
            [],
        )

    def test_browser_format_supports_compatible_progressive_fallback(self) -> None:
        formats = [
            self.format_info(
                "progressive-avc", "mp4", 480, "avc1.4d401e", "mp4a.40.2"
            ),
            self.format_info(
                "progressive-av1", "mp4", 720, "av01.0.08M.08", "mp4a.40.2"
            ),
        ]
        downloader = YoutubeDL({"quiet": True, "no_warnings": True})
        selected = downloader._select_formats(
            formats,
            downloader.build_format_selector(BROWSER_COMPATIBLE_FORMAT),
        )

        self.assertEqual([item["format_id"] for item in selected], ["progressive-avc"])

    def test_probe_accepts_browser_compatible_mp4(self) -> None:
        validate_artifact_probe(self.compatible_probe(), max_duration=60)

    def test_probe_rejects_incompatible_container_codecs_and_tracks(self) -> None:
        cases = (
            (
                self.compatible_probe(
                    format={"format_name": "matroska,webm", "duration": "60"}
                ),
                "UNSUPPORTED_CONTAINER",
            ),
            (
                self.compatible_probe(
                    streams=[{
                        "codec_type": "video",
                        "codec_name": "av1",
                    }, {"codec_type": "audio", "codec_name": "aac"}]
                ),
                "UNSUPPORTED_VIDEO_CODEC",
            ),
            (
                self.compatible_probe(
                    streams=[{
                        "codec_type": "video",
                        "codec_name": "hevc",
                    }, {"codec_type": "audio", "codec_name": "aac"}]
                ),
                "UNSUPPORTED_VIDEO_CODEC",
            ),
            (
                self.compatible_probe(
                    streams=[
                        {
                            "codec_type": "video",
                            "codec_name": "h264",
                        },
                        {"codec_type": "audio", "codec_name": "opus"},
                    ]
                ),
                "UNSUPPORTED_AUDIO_CODEC",
            ),
            (
                self.compatible_probe(
                    streams=[
                        {"codec_type": "video", "codec_name": "h264"},
                        {"codec_type": "video", "codec_name": "av1"},
                        {"codec_type": "audio", "codec_name": "aac"},
                    ]
                ),
                "UNSUPPORTED_VIDEO_CODEC",
            ),
            (
                self.compatible_probe(
                    streams=[
                        {"codec_type": "video", "codec_name": "h264"},
                        {"codec_type": "audio", "codec_name": "aac"},
                        {"codec_type": "audio", "codec_name": "opus"},
                    ]
                ),
                "UNSUPPORTED_AUDIO_CODEC",
            ),
            (
                self.compatible_probe(
                    streams=[{"codec_type": "video", "codec_name": "h264"}]
                ),
                "PROBE_FAILED",
            ),
            (self.compatible_probe(streams=[]), "PROBE_FAILED"),
        )
        for payload, expected_code in cases:
            with self.subTest(expected_code=expected_code):
                with self.assertRaises(WorkerFailure) as caught:
                    validate_artifact_probe(payload, max_duration=60)
                self.assertEqual(caught.exception.code, expected_code)

    def test_verify_artifact_requests_and_enforces_codec_metadata(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            artifact = Path(temporary) / "artifact.mp4"
            artifact.write_bytes(b"browser-compatible-video")
            probe_result = subprocess.CompletedProcess(
                args=[],
                returncode=0,
                stdout=json.dumps(self.compatible_probe()),
                stderr="",
            )
            with patch("media_service.worker.subprocess.run", return_value=probe_result) as run:
                size, sha256, width, height = verify_artifact(
                    "ffprobe",
                    artifact,
                    max_duration=60,
                    max_bytes=1024,
                )

            command = run.call_args.args[0]
            entries = command[command.index("-show_entries") + 1]
            self.assertIn("format_name", entries)
            self.assertIn("codec_name", entries)
            self.assertIn("width", entries)
            self.assertIn("height", entries)
            self.assertEqual(size, artifact.stat().st_size)
            self.assertEqual(len(sha256), 64)
            self.assertEqual(width, 1280)
            self.assertEqual(height, 720)

    def test_verify_artifact_rejects_av1_from_ffprobe(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            artifact = Path(temporary) / "artifact.mp4"
            artifact.write_bytes(b"av1-video")
            probe_result = subprocess.CompletedProcess(
                args=[],
                returncode=0,
                stdout=json.dumps(
                    self.compatible_probe(
                        streams=[
                            {"codec_type": "video", "codec_name": "av1"},
                            {"codec_type": "audio", "codec_name": "aac"},
                        ]
                    )
                ),
                stderr="",
            )
            with patch("media_service.worker.subprocess.run", return_value=probe_result):
                with self.assertRaises(WorkerFailure) as caught:
                    verify_artifact(
                        "ffprobe",
                        artifact,
                        max_duration=60,
                        max_bytes=1024,
                    )

            self.assertEqual(caught.exception.code, "UNSUPPORTED_VIDEO_CODEC")

    def test_verify_artifact_rejects_non_mp4_path_before_probe(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            artifact = Path(temporary) / "artifact.mov"
            artifact.write_bytes(b"quicktime-video")
            with patch("media_service.worker.subprocess.run") as run:
                with self.assertRaises(WorkerFailure) as caught:
                    verify_artifact(
                        "ffprobe",
                        artifact,
                        max_duration=60,
                        max_bytes=1024,
                    )

            self.assertEqual(caught.exception.code, "UNSUPPORTED_CONTAINER")
            run.assert_not_called()

    def test_missing_compatible_format_is_not_retryable(self) -> None:
        for resolving in (False, True):
            with self.subTest(resolving=resolving):
                error = classify_download_error(
                    "Requested format is not available",
                    resolving=resolving,
                )
                self.assertEqual(error.code, "UNSUPPORTED_VIDEO_CODEC")
                self.assertFalse(error.retryable)

    @staticmethod
    def format_info(format_id, ext, height, vcodec, acodec, width=None):
        return {
            "format_id": format_id,
            "ext": ext,
            "width": width if width is not None else (round(height * 16 / 9) if height else None),
            "height": height,
            "vcodec": vcodec,
            "acodec": acodec,
            "url": f"https://example.test/{format_id}",
            "protocol": "https",
        }

    def test_estimates_combined_dash_stream_size(self) -> None:
        info = {
            "requested_formats": [
                {"filesize": 100},
                {"filesize_approx": 25},
            ]
        }
        self.assertEqual(estimate_download_bytes(info), 125)

    def test_rejects_long_large_live_and_unknown_videos(self) -> None:
        cases = (
            (self.public_info(duration=3_601, title="long"), "VIDEO_TOO_LONG"),
            (
                self.public_info(duration=60, title="large", filesize=301),
                "VIDEO_TOO_LARGE",
            ),
            (self.public_info(duration=60, title="live", is_live=True), "LIVE_NOT_SUPPORTED"),
            (self.public_info(title="unknown"), "DURATION_UNKNOWN"),
            (
                self.public_info(duration=60, title="bangumi", extractor_key="BiliBiliBangumi"),
                "UNSUPPORTED_VIDEO",
            ),
            (
                self.public_info(duration=60, title="premium", availability="premium_only"),
                "ACCESS_RESTRICTED",
            ),
        )
        for info, expected_code in cases:
            with self.subTest(expected_code=expected_code):
                with self.assertRaises(WorkerFailure) as caught:
                    validate_video_info(info, max_duration=3_600, max_bytes=300)
                self.assertEqual(caught.exception.code, expected_code)

    def test_accepts_video_at_the_limits(self) -> None:
        title, duration = validate_video_info(
            self.public_info(duration=3_600, title="sample", filesize=300),
            max_duration=3_600,
            max_bytes=300,
        )
        self.assertEqual(title, "sample")
        self.assertEqual(duration, 3_600)

    def test_download_filename_removes_path_and_control_characters(self) -> None:
        filename = safe_download_filename(
            '../bad\\name:\n"video"', "BV1xx411c7mD", ".mp4"
        )
        self.assertNotIn("/", filename)
        self.assertNotIn("\\", filename)
        self.assertNotIn("\n", filename)
        self.assertTrue(filename.endswith("[BV1xx411c7mD].mp4"))


if __name__ == "__main__":
    unittest.main()
