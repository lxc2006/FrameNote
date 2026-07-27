from __future__ import annotations

import unittest
import tempfile
from pathlib import Path
from unittest.mock import Mock, patch

from media_service.analysis_pipeline import (
    _normalize_funasr_result,
    _prefer_cached_modelscope_model,
    _read_frame,
    _repunctuate_with_ct_punc,
    build_analysis_manifest,
    complete_analysis_transcript,
    uniform_frame_targets,
)


class AnalysisPipelineTests(unittest.TestCase):
    def test_ct_punc_receives_unpunctuated_text(self) -> None:
        punctuation_model = Mock()
        punctuation_model.generate.return_value = [
            {"text": "这会导致癌症率飙升。"}
        ]
        with patch(
            "media_service.analysis_pipeline._load_funasr_punctuation_model",
            return_value=punctuation_model,
        ):
            restored = _repunctuate_with_ct_punc(
                "这会导致。癌症率飙升。",
                "ct-punc",
                "cpu",
                "ms",
            )

        self.assertEqual(restored, "这会导致癌症率飙升。")
        punctuation_model.generate.assert_called_once_with(
            input="这会导致癌症率飙升"
        )

    def test_modelscope_loader_prefers_an_existing_cached_snapshot(self) -> None:
        with patch(
            "modelscope.hub.snapshot_download.snapshot_download",
            return_value="C:/cached/nano",
        ) as snapshot_download:
            resolved = _prefer_cached_modelscope_model(
                "FunAudioLLM/Fun-ASR-Nano-2512",
                "ms",
            )

        self.assertEqual(resolved, "C:/cached/nano")
        snapshot_download.assert_called_once_with(
            "FunAudioLLM/Fun-ASR-Nano-2512",
            local_files_only=True,
        )

    def test_ct_punc_alias_resolves_the_model_used_by_funasr(self) -> None:
        with patch(
            "modelscope.hub.snapshot_download.snapshot_download",
            return_value="C:/cached/ct-punc",
        ) as snapshot_download:
            resolved = _prefer_cached_modelscope_model("ct-punc", "ms")

        self.assertEqual(resolved, "C:/cached/ct-punc")
        snapshot_download.assert_called_once_with(
            "iic/punc_ct-transformer_cn-en-common-vocab471067-large",
            local_files_only=True,
        )

    def test_modelscope_loader_falls_back_to_remote_name_without_cache(self) -> None:
        with patch(
            "modelscope.hub.snapshot_download.snapshot_download",
            side_effect=FileNotFoundError,
        ):
            resolved = _prefer_cached_modelscope_model(
                "FunAudioLLM/Fun-ASR-Nano-2512",
                "ms",
            )

        self.assertEqual(resolved, "FunAudioLLM/Fun-ASR-Nano-2512")

    def test_nano_character_timestamps_create_readable_subtitle_cues(self) -> None:
        characters = list("今天天气很好，但是下午可能下雨。记得带伞！")
        timestamps = []
        current_time = 0.2
        for character in characters:
            timestamps.append(
                {
                    "token": character,
                    "start_time": current_time,
                    "end_time": current_time + 0.16,
                }
            )
            current_time += 0.22
            if character == "，":
                current_time += 0.7

        transcript = _normalize_funasr_result(
            [
                {
                    "text": "".join(characters),
                    "timestamps": timestamps,
                }
            ],
            30,
        )

        self.assertEqual(transcript["status"], "ready")
        self.assertEqual(
            [cue["text"] for cue in transcript["cues"]],
            ["今天天气很好，但是下午可能下雨。", "记得带伞！"],
        )
        self.assertGreater(
            transcript["cues"][1]["startSeconds"],
            transcript["cues"][0]["endSeconds"],
        )

    def test_ct_punc_boundaries_replace_nano_punctuation_without_moving_text(
        self,
    ) -> None:
        characters = list("这会导致。癌症率飙升。")
        transcript = _normalize_funasr_result(
            [
                {
                    "text": "".join(characters),
                    "timestamps": [
                        {
                            "token": character,
                            "start_time": 496 + index * 0.12,
                            "end_time": 496 + index * 0.12 + 0.1,
                        }
                        for index, character in enumerate(characters)
                    ],
                }
            ],
            600,
            "这会导致癌症率飙升。",
        )

        self.assertEqual(
            transcript["cues"],
            [
                {
                    "startSeconds": 496.0,
                    "endSeconds": 497.18,
                    "text": "这会导致癌症率飙升。",
                }
            ],
        )

    def test_incompatible_ct_punc_text_falls_back_to_nano_boundaries(self) -> None:
        characters = list("第一句。第二句。")
        transcript = _normalize_funasr_result(
            [
                {
                    "text": "".join(characters),
                    "timestamps": [
                        {
                            "token": character,
                            "start_time": index * 0.1,
                            "end_time": index * 0.1 + 0.08,
                        }
                        for index, character in enumerate(characters)
                    ],
                }
            ],
            10,
            "模型增加了原文没有的字。",
        )

        self.assertEqual(
            [cue["text"] for cue in transcript["cues"]],
            ["第一句。", "第二句。"],
        )

    def test_standard_character_timestamps_remain_supported(self) -> None:
        transcript = _normalize_funasr_result(
            [
                {
                    "text": "你好！",
                    "timestamp": [[100, 240], [240, 380], [380, 420]],
                }
            ],
            10,
        )
        self.assertEqual(
            transcript["cues"],
            [
                {
                    "startSeconds": 0.1,
                    "endSeconds": 0.42,
                    "text": "你好！",
                }
            ],
        )

    def test_long_sentence_is_not_split_at_a_comma_or_character_limit(self) -> None:
        characters = list("一" * 24 + "，" + "二" * 24 + "。")
        transcript = _normalize_funasr_result(
            [
                {
                    "text": "".join(characters),
                    "timestamps": [
                        {
                            "token": character,
                            "start_time": index * 0.1,
                            "end_time": index * 0.1 + 0.08,
                        }
                        for index, character in enumerate(characters)
                    ],
                }
            ],
            10,
        )

        self.assertEqual(
            [cue["text"] for cue in transcript["cues"]],
            ["一" * 24 + "，" + "二" * 24 + "。"],
        )

    def test_sentence_info_is_used_when_character_timestamps_are_missing(self) -> None:
        transcript = _normalize_funasr_result(
            [
                {
                    "text": "兼容旧字幕。",
                    "sentence_info": [
                        {
                            "text": "兼容旧字幕。",
                            "start": 1000,
                            "end": 2400,
                        }
                    ],
                }
            ],
            10,
        )

        self.assertEqual(
            transcript["cues"],
            [
                {
                    "startSeconds": 1.0,
                    "endSeconds": 2.4,
                    "text": "兼容旧字幕。",
                }
            ],
        )

    def test_read_frame_reports_the_decoded_frame_timestamp(self) -> None:
        class Frame:
            size = 1

        class Cv2:
            CAP_PROP_POS_MSEC = 1
            CAP_PROP_POS_FRAMES = 2
            CAP_PROP_FPS = 3

        class Capture:
            def set(self, *_args):
                return True

            def read(self):
                return True, Frame()

            def get(self, property_id):
                return {
                    Cv2.CAP_PROP_POS_MSEC: 12_480,
                    Cv2.CAP_PROP_POS_FRAMES: 313,
                    Cv2.CAP_PROP_FPS: 25,
                }[property_id]

        decoded = _read_frame(Capture(), Cv2(), 12.5)
        self.assertIsNotNone(decoded)
        _, timestamp = decoded or (None, 0)
        self.assertAlmostEqual(timestamp, 12.48, places=2)

    def test_uniform_interval_has_one_second_lower_bound(self) -> None:
        self.assertEqual(uniform_frame_targets(3), [0.0, 1.0, 2.0, 2.95])

    def test_long_video_uses_duration_divided_by_fifty(self) -> None:
        targets = uniform_frame_targets(600)
        self.assertEqual(targets[:3], [0.0, 12.0, 24.0])
        self.assertLessEqual(len(targets), 51)
        self.assertAlmostEqual(targets[-1], 599.95, places=2)

    def test_direct_mode_defers_funasr_until_after_qwen_can_start(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            output_dir = Path(temporary)
            video_path = output_dir / "artifact.mp4"
            video_path.write_bytes(b"video")
            calls: list[str] = []
            progress: list[tuple[str, float]] = []

            def extract_audio(*_args):
                calls.append("audio")
                mp3 = output_dir / "analysis-audio.mp3"
                wav = output_dir / "analysis-asr.wav"
                mp3.write_bytes(b"mp3")
                wav.write_bytes(b"wav")
                return mp3, wav

            def transcribe(*_args):
                calls.append("funasr")
                return {
                    "status": "ready",
                    "language": "zh",
                    "text": "字幕",
                    "cues": [],
                }

            def extract_asr(*_args):
                calls.append("funasr-audio")
                wav = output_dir / "analysis-asr.wav"
                wav.write_bytes(b"wav")
                return wav

            with (
                patch(
                    "media_service.analysis_pipeline.extract_analysis_audio",
                    side_effect=extract_audio,
                ) as extract_audio_mock,
                patch(
                    "media_service.analysis_pipeline.transcribe_with_funasr",
                    side_effect=transcribe,
                ) as transcribe_mock,
                patch(
                    "media_service.analysis_pipeline.extract_keyframes"
                ) as extract_keyframes,
            ):
                manifest_path, manifest = build_analysis_manifest(
                    video_path,
                    output_dir,
                    120,
                    "ffmpeg",
                    include_keyframes=False,
                    on_progress=lambda stage, value: progress.append((stage, value)),
                )

            extract_keyframes.assert_not_called()
            extract_audio_mock.assert_not_called()
            transcribe_mock.assert_not_called()
            self.assertEqual(calls, [])
            self.assertEqual(manifest["mode"], "direct")
            self.assertEqual(manifest["frames"], [])
            self.assertEqual(manifest["transcript"]["status"], "pending")
            self.assertTrue(manifest_path.is_file())
            self.assertEqual(progress[-1], ("ready", 1.0))

            with (
                patch(
                    "media_service.analysis_pipeline.extract_funasr_audio",
                    side_effect=extract_asr,
                ),
                patch(
                    "media_service.analysis_pipeline.transcribe_with_funasr",
                    side_effect=transcribe,
                ),
            ):
                transcript = complete_analysis_transcript(
                    output_dir,
                    120,
                    video_path,
                    "ffmpeg",
                )
            self.assertEqual(calls, ["funasr-audio", "funasr"])
            self.assertEqual(transcript["text"], "字幕")
            self.assertFalse((output_dir / "analysis-asr.wav").exists())

    def test_long_mode_prepares_keyframes_before_deferred_funasr(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            output_dir = Path(temporary)
            video_path = output_dir / "artifact.mp4"
            video_path.write_bytes(b"video")
            calls: list[str] = []

            def extract_audio(*_args):
                calls.append("audio")
                mp3 = output_dir / "analysis-audio.mp3"
                wav = output_dir / "analysis-asr.wav"
                mp3.write_bytes(b"mp3")
                wav.write_bytes(b"wav")
                return mp3, wav

            def extract_frames(*_args):
                calls.append("keyframes")
                return [
                    {
                        "filename": "analysis-frame-001.jpg",
                        "timestampSeconds": 1,
                        "score": 0.9,
                        "sizeBytes": 10,
                    }
                ]

            def transcribe(*_args):
                calls.append("funasr")
                return {
                    "status": "unavailable",
                    "language": "zh",
                    "text": "",
                    "cues": [],
                }

            with (
                patch(
                    "media_service.analysis_pipeline.extract_analysis_audio",
                    side_effect=extract_audio,
                ),
                patch(
                    "media_service.analysis_pipeline.extract_keyframes",
                    side_effect=extract_frames,
                ),
                patch(
                    "media_service.analysis_pipeline.transcribe_with_funasr",
                    side_effect=transcribe,
                ) as transcribe_mock,
            ):
                _, manifest = build_analysis_manifest(
                    video_path,
                    output_dir,
                    1_200,
                    "ffmpeg",
                    include_keyframes=True,
                )

            transcribe_mock.assert_not_called()
            self.assertEqual(calls, ["audio", "keyframes"])
            self.assertEqual(manifest["mode"], "keyframes")
            self.assertEqual(len(manifest["frames"]), 1)
            self.assertEqual(manifest["transcript"]["status"], "pending")
