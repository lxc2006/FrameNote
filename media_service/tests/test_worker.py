from __future__ import annotations

import unittest

from media_service.worker import (
    WorkerFailure,
    estimate_download_bytes,
    safe_download_filename,
    validate_video_info,
)


class WorkerValidationTests(unittest.TestCase):
    @staticmethod
    def public_info(**values):
        return {"extractor_key": "BiliBili", "availability": "public", **values}

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
