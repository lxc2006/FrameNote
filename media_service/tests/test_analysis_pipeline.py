from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from media_service.analysis_pipeline import build_analysis_manifest, uniform_frame_targets


class AnalysisPipelineTests(unittest.TestCase):
    def test_uniform_interval_has_one_second_lower_bound(self) -> None:
        self.assertEqual(uniform_frame_targets(3), [0.0, 1.0, 2.0, 2.95])

    def test_long_video_uses_duration_divided_by_fifty(self) -> None:
        targets = uniform_frame_targets(600)
        self.assertEqual(targets[:3], [0.0, 12.0, 24.0])
        self.assertLessEqual(len(targets), 51)
        self.assertAlmostEqual(targets[-1], 599.95, places=2)

    def test_manifest_contains_api_sized_transcription_audio(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            output_dir = Path(temporary)
            video_path = output_dir / "artifact.mp4"
            video_path.write_bytes(b"video")
            audio_path = output_dir / "analysis-audio.mp3"
            audio_path.write_bytes(b"audio")
            chunks = [
                {
                    "filename": audio_path.name,
                    "mimeType": "audio/mpeg",
                    "sizeBytes": audio_path.stat().st_size,
                    "startSeconds": 0.0,
                    "endSeconds": 120.0,
                }
            ]

            with (
                patch(
                    "media_service.analysis_pipeline.extract_analysis_audio",
                    return_value=(audio_path, chunks),
                ),
                patch("media_service.analysis_pipeline.extract_keyframes") as frames,
            ):
                manifest_path, manifest = build_analysis_manifest(
                    video_path,
                    output_dir,
                    120,
                    "ffmpeg",
                    include_keyframes=False,
                )

            frames.assert_not_called()
            self.assertEqual(manifest["mode"], "direct")
            self.assertEqual(manifest["frames"], [])
            self.assertEqual(manifest["transcriptionAudio"], chunks)
            self.assertTrue(manifest_path.is_file())


if __name__ == "__main__":
    unittest.main()
