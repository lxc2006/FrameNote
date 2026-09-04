from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from media_service.transcription import (
    TRANSCRIPTION_NOT_INSTALLED,
    complete_analysis_transcript,
)


class OptionalTranscriptionTests(unittest.TestCase):
    def test_missing_extension_marks_transcript_unavailable(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            output_dir = Path(temporary)
            manifest_path = output_dir / "analysis-manifest.json"
            manifest_path.write_text(
                json.dumps(
                    {
                        "version": 1,
                        "mode": "direct",
                        "audio": None,
                        "frames": [],
                        "transcript": {
                            "status": "pending",
                            "language": "zh",
                            "text": "",
                            "cues": [],
                        },
                    }
                ),
                encoding="utf-8",
            )

            with (
                patch("media_service.transcription._extension_executable", return_value=None),
                patch("media_service.transcription._load_backend", return_value=None),
            ):
                transcript = complete_analysis_transcript(
                    output_dir,
                    30,
                    output_dir / "artifact.mp4",
                    "ffmpeg",
                    ("zh", "en"),
                )

            self.assertEqual(transcript["status"], "unavailable")
            self.assertEqual(transcript["language"], "zh,en")
            self.assertEqual(transcript["error"], TRANSCRIPTION_NOT_INSTALLED)
            stored = json.loads(manifest_path.read_text(encoding="utf-8"))
            self.assertEqual(stored["transcript"], transcript)
            self.assertFalse((output_dir / "analysis-asr.wav").exists())

    def test_external_extension_is_used_without_importing_subtitle_packages(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            output_dir = Path(temporary)
            (output_dir / "analysis-asr.wav").write_bytes(b"RIFF-test")
            (output_dir / "analysis-manifest.json").write_text(
                json.dumps(
                    {
                        "version": 1,
                        "mode": "direct",
                        "audio": None,
                        "frames": [],
                        "transcript": {"status": "pending", "text": "", "cues": []},
                    }
                ),
                encoding="utf-8",
            )
            ready = {
                "status": "ready",
                "language": "zh",
                "text": "字幕扩展正常。",
                "cues": [
                    {
                        "startSeconds": 0,
                        "endSeconds": 1,
                        "text": "字幕扩展正常。",
                    }
                ],
            }
            with (
                patch(
                    "media_service.transcription._extension_executable",
                    return_value=Path("framenote-subtitles.exe"),
                ),
                patch(
                    "media_service.transcription._run_extension",
                    return_value=ready,
                ) as run_extension,
            ):
                transcript = complete_analysis_transcript(
                    output_dir,
                    1,
                    languages=("zh",),
                )

            self.assertEqual(transcript, ready)
            run_extension.assert_called_once()
            self.assertFalse((output_dir / "analysis-asr.wav").exists())


if __name__ == "__main__":
    unittest.main()
