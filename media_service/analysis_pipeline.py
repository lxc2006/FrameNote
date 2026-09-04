from __future__ import annotations

import json
import math
import re
import subprocess
import unicodedata
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable


MAX_KEYFRAMES = 64
MAX_SCENE_TARGETS = 80
PHASH_DUPLICATE_DISTANCE = 8
SENTENCE_ENDINGS = ("。", "！", "？", "!", "?")
CONTROL_TOKEN_PATTERN = re.compile(r"<\|[^|]+\|>")
TOKEN_UNIT_PATTERN = re.compile(
    r"[A-Za-z0-9]+(?:['’.-][A-Za-z0-9]+)*|[\u3400-\u9fff]|[^\w\s]",
)
@dataclass(slots=True)
class FrameCandidate:
    timestamp: float
    image: Any
    phash: Any
    quality: float
    scene_target: bool
    uniqueness: float = 0.0

    @property
    def score(self) -> float:
        return self.quality + self.uniqueness * 0.28 + (0.08 if self.scene_target else 0)


def uniform_frame_targets(duration_seconds: float) -> list[float]:
    """Use k1=max(1, duration/50), producing about 50 anchors for long videos."""
    if not math.isfinite(duration_seconds) or duration_seconds <= 0:
        return []
    interval = max(1.0, duration_seconds / 50.0)
    targets: list[float] = []
    timestamp = 0.0
    final_timestamp = max(0.0, duration_seconds - 0.05)
    while timestamp <= final_timestamp:
        targets.append(round(timestamp, 3))
        timestamp += interval
    if not targets or final_timestamp - targets[-1] >= interval * 0.55:
        targets.append(round(final_timestamp, 3))
    return targets


def _evenly_limit(values: list[float], limit: int) -> list[float]:
    if len(values) <= limit:
        return values
    if limit <= 1:
        return [values[len(values) // 2]]
    return [
        values[round(index * (len(values) - 1) / (limit - 1))]
        for index in range(limit)
    ]


def scene_change_targets(video_path: Path) -> list[float]:
    try:
        from scenedetect import AdaptiveDetector, detect
    except ImportError:
        return []

    scenes = detect(
        str(video_path),
        AdaptiveDetector(
            adaptive_threshold=3.0,
            min_scene_len=12,
            window_width=2,
            min_content_val=15.0,
        ),
        start_in_scene=True,
        show_progress=False,
    )
    starts = sorted(
        {
            round(float(start.get_seconds()), 3)
            for start, _ in scenes
            if start.get_seconds() > 0
        }
    )
    return _evenly_limit(starts, MAX_SCENE_TARGETS)


def _candidate_offsets(anchor: float, interval: float, duration: float) -> list[float]:
    radius = min(0.75, max(0.12, interval * 0.18))
    final_timestamp = max(0.0, duration - 0.05)
    return sorted(
        {
            round(min(final_timestamp, max(0.0, anchor + radius * step / 2)), 3)
            for step in (-2, -1, 0, 1, 2)
        }
    )


def _read_frame(
    capture: Any,
    cv2: Any,
    timestamp: float,
) -> tuple[Any, float] | None:
    capture.set(cv2.CAP_PROP_POS_MSEC, timestamp * 1000)
    success, frame = capture.read()
    if not success or frame is None or frame.size == 0:
        return None

    observed_timestamps: list[float] = []
    position_milliseconds = float(capture.get(cv2.CAP_PROP_POS_MSEC))
    if math.isfinite(position_milliseconds) and position_milliseconds >= 0:
        observed_timestamps.append(position_milliseconds / 1000)
    position_frames = float(capture.get(cv2.CAP_PROP_POS_FRAMES))
    frames_per_second = float(capture.get(cv2.CAP_PROP_FPS))
    if (
        math.isfinite(position_frames)
        and math.isfinite(frames_per_second)
        and position_frames >= 1
        and frames_per_second > 0
    ):
        observed_timestamps.append((position_frames - 1) / frames_per_second)

    plausible_timestamps = [
        value
        for value in observed_timestamps
        if abs(value - timestamp) <= 2.0
    ]
    actual_timestamp = (
        min(plausible_timestamps, key=lambda value: abs(value - timestamp))
        if plausible_timestamps
        else timestamp
    )
    return frame, actual_timestamp


def _frame_quality(frame: Any, cv2: Any, np: Any) -> float:
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    sharpness = float(cv2.Laplacian(gray, cv2.CV_64F).var())
    contrast = float(gray.std())
    brightness = float(gray.mean())
    histogram = cv2.calcHist([gray], [0], None, [64], [0, 256]).ravel()
    probability = histogram / max(1.0, float(histogram.sum()))
    entropy = -float(
        sum(value * math.log2(value) for value in probability if value > 0)
    )
    sharpness_score = min(1.0, math.log1p(sharpness) / math.log1p(1_500))
    contrast_score = min(1.0, contrast / 72.0)
    exposure_score = max(0.0, 1.0 - abs(brightness - 127.5) / 127.5)
    entropy_score = min(1.0, entropy / 6.0)
    return (
        sharpness_score * 0.48
        + contrast_score * 0.20
        + exposure_score * 0.14
        + entropy_score * 0.18
    )


def _best_candidate(
    capture: Any,
    cv2: Any,
    np: Any,
    imagehash: Any,
    image_type: Any,
    anchor: float,
    interval: float,
    duration: float,
    scene_target: bool,
) -> FrameCandidate | None:
    best: FrameCandidate | None = None
    for timestamp in _candidate_offsets(anchor, interval, duration):
        decoded = _read_frame(capture, cv2, timestamp)
        if decoded is None:
            continue
        frame, actual_timestamp = decoded
        quality = _frame_quality(frame, cv2, np)
        rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        phash = imagehash.phash(image_type.fromarray(rgb), hash_size=8)
        candidate = FrameCandidate(
            timestamp=min(max(0.0, actual_timestamp), max(0.0, duration - 0.05)),
            image=frame,
            phash=phash,
            quality=quality,
            scene_target=scene_target,
        )
        if best is None or candidate.quality > best.quality:
            best = candidate
    return best


def _rank_and_deduplicate(candidates: list[FrameCandidate]) -> list[FrameCandidate]:
    if not candidates:
        return []
    for candidate in candidates:
        distances = [
            int(candidate.phash - other.phash)
            for other in candidates
            if other is not candidate
        ]
        candidate.uniqueness = (min(distances) / 64.0) if distances else 1.0

    selected: list[FrameCandidate] = []
    for candidate in sorted(candidates, key=lambda item: item.score, reverse=True):
        if any(
            int(candidate.phash - existing.phash) <= PHASH_DUPLICATE_DISTANCE
            for existing in selected
        ):
            continue
        selected.append(candidate)
        if len(selected) >= MAX_KEYFRAMES:
            break
    return sorted(selected, key=lambda item: item.timestamp)


def extract_keyframes(
    video_path: Path,
    output_dir: Path,
    duration_seconds: float,
) -> list[dict[str, Any]]:
    try:
        import cv2
        import imagehash
        import numpy as np
        from PIL import Image
    except ImportError as exc:
        raise RuntimeError(
            "关键帧依赖未安装，请安装 scenedetect-headless、ImageHash、Pillow 和 numpy。"
        ) from exc

    capture = cv2.VideoCapture(str(video_path))
    if not capture.isOpened():
        raise RuntimeError("OpenCV 无法打开分析视频。")
    try:
        interval = max(1.0, duration_seconds / 50.0)
        uniform_targets = uniform_frame_targets(duration_seconds)
        scene_targets = scene_change_targets(video_path)
        target_map: dict[float, bool] = {
            timestamp: False for timestamp in uniform_targets
        }
        for timestamp in scene_targets:
            target_map[timestamp] = True

        candidates: list[FrameCandidate] = []
        for timestamp, is_scene in sorted(target_map.items()):
            candidate = _best_candidate(
                capture,
                cv2,
                np,
                imagehash,
                Image,
                timestamp,
                min(interval, 1.5) if is_scene else interval,
                duration_seconds,
                is_scene,
            )
            if candidate:
                candidates.append(candidate)
    finally:
        capture.release()

    selected = _rank_and_deduplicate(candidates)
    manifest_frames: list[dict[str, Any]] = []
    for index, candidate in enumerate(selected, start=1):
        filename = f"analysis-frame-{index:03d}.jpg"
        path = output_dir / filename
        height, width = candidate.image.shape[:2]
        max_edge = 640
        scale = min(1.0, max_edge / max(width, height))
        image = candidate.image
        if scale < 1:
            image = cv2.resize(
                image,
                (max(2, round(width * scale)), max(2, round(height * scale))),
                interpolation=cv2.INTER_AREA,
            )
        if not cv2.imwrite(str(path), image, [cv2.IMWRITE_JPEG_QUALITY, 78]):
            raise RuntimeError("关键帧 JPEG 写入失败。")
        manifest_frames.append(
            {
                "filename": filename,
                "timestampSeconds": round(candidate.timestamp, 3),
                "score": round(candidate.score, 4),
                "sizeBytes": path.stat().st_size,
            }
        )
    return manifest_frames


def extract_analysis_audio(ffmpeg: str, video_path: Path, output_dir: Path) -> tuple[Path, Path]:
    mp3_path = output_dir / "analysis-audio.mp3"
    wav_path = output_dir / "analysis-asr.wav"
    commands = (
        [
            ffmpeg,
            "-v",
            "error",
            "-i",
            str(video_path),
            "-map",
            "0:a:0",
            "-vn",
            "-ac",
            "1",
            "-ar",
            "16000",
            "-b:a",
            "40k",
            "-y",
            str(mp3_path),
        ],
        [
            ffmpeg,
            "-v",
            "error",
            "-i",
            str(video_path),
            "-map",
            "0:a:0",
            "-vn",
            "-ac",
            "1",
            "-ar",
            "16000",
            "-c:a",
            "pcm_s16le",
            "-y",
            str(wav_path),
        ],
    )
    for command in commands:
        result = subprocess.run(
            command,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=600,
            check=False,
            shell=False,
        )
        if result.returncode != 0:
            raise RuntimeError("FFmpeg 无法提取分析音轨。")
    return mp3_path, wav_path


def extract_funasr_audio(
    ffmpeg: str,
    video_path: Path,
    output_dir: Path,
) -> Path:
    wav_path = output_dir / "analysis-asr.wav"
    result = subprocess.run(
        [
            ffmpeg,
            "-v",
            "error",
            "-i",
            str(video_path),
            "-map",
            "0:a:0",
            "-vn",
            "-ac",
            "1",
            "-ar",
            "16000",
            "-c:a",
            "pcm_s16le",
            "-y",
            str(wav_path),
        ],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=600,
        check=False,
        shell=False,
    )
    if result.returncode != 0:
        raise RuntimeError("FFmpeg 无法提取 FunASR 音轨。")
    return wav_path


@dataclass(frozen=True, slots=True)
class TimedSubtitleToken:
    text: str
    start_seconds: float
    end_seconds: float


def _normalized_token_text(value: Any) -> str:
    token = str(value or "").replace("▁", " ").replace("Ġ", " ")
    return CONTROL_TOKEN_PATTERN.sub("", token)


def _join_subtitle_tokens(tokens: list[TimedSubtitleToken]) -> str:
    output = ""
    for timed_token in tokens:
        raw_token = timed_token.text
        token = raw_token.strip()
        if not token:
            continue
        previous = output[-1] if output else ""
        first = token[0]
        needs_space = bool(output) and (
            raw_token[:1].isspace()
            or (
                previous.isascii()
                and previous.isalnum()
                and first.isascii()
                and first.isalnum()
            )
        )
        if needs_space:
            output += " "
        output += token
    return output.strip()


def _seconds_value(value: Any, *, milliseconds: bool) -> float | None:
    if not isinstance(value, (int, float)) or not math.isfinite(float(value)):
        return None
    normalized = float(value) / 1000 if milliseconds else float(value)
    return max(0.0, normalized)


def _nano_timed_tokens(
    item: dict[str, Any],
    duration_seconds: float,
) -> list[TimedSubtitleToken]:
    raw_timestamps = item.get("timestamps")
    if not isinstance(raw_timestamps, list):
        return []
    tokens: list[TimedSubtitleToken] = []
    for raw_timestamp in raw_timestamps:
        if not isinstance(raw_timestamp, dict):
            continue
        token = _normalized_token_text(
            raw_timestamp.get("token")
            or raw_timestamp.get("word")
            or raw_timestamp.get("text")
        )
        start = _seconds_value(
            raw_timestamp.get("start_time", raw_timestamp.get("start")),
            milliseconds=False,
        )
        end = _seconds_value(
            raw_timestamp.get("end_time", raw_timestamp.get("end")),
            milliseconds=False,
        )
        if not token or start is None or end is None:
            continue
        start = min(duration_seconds, start)
        end = min(duration_seconds, max(start + 0.01, end))
        tokens.append(TimedSubtitleToken(token, start, end))
    return sorted(tokens, key=lambda token: (token.start_seconds, token.end_seconds))


def _standard_timestamp_text_units(text: str, count: int) -> list[str]:
    lexical_units = TOKEN_UNIT_PATTERN.findall(text)
    if len(lexical_units) == count:
        return lexical_units
    character_units = [character for character in text if not character.isspace()]
    return character_units if len(character_units) == count else []


def _standard_timed_tokens(
    item: dict[str, Any],
    text: str,
    duration_seconds: float,
) -> list[TimedSubtitleToken]:
    raw_timestamps = item.get("timestamp")
    if not isinstance(raw_timestamps, list):
        return []
    text_units = _standard_timestamp_text_units(text, len(raw_timestamps))
    if not text_units:
        return []
    tokens: list[TimedSubtitleToken] = []
    for text_unit, raw_timestamp in zip(text_units, raw_timestamps, strict=True):
        if (
            not isinstance(raw_timestamp, (list, tuple))
            or len(raw_timestamp) != 2
        ):
            return []
        start = _seconds_value(raw_timestamp[0], milliseconds=True)
        end = _seconds_value(raw_timestamp[1], milliseconds=True)
        if start is None or end is None:
            return []
        start = min(duration_seconds, start)
        end = min(duration_seconds, max(start + 0.01, end))
        tokens.append(TimedSubtitleToken(text_unit, start, end))
    return tokens


def _subtitle_cues_from_tokens(
    tokens: list[TimedSubtitleToken],
    duration_seconds: float,
) -> list[dict[str, Any]]:
    cues: list[dict[str, Any]] = []
    current: list[TimedSubtitleToken] = []

    def flush() -> None:
        if not current:
            return
        cue_text = _join_subtitle_tokens(current)
        if cue_text:
            start_seconds = min(duration_seconds, current[0].start_seconds)
            end_seconds = min(
                duration_seconds,
                max(start_seconds + 0.01, current[-1].end_seconds),
            )
            cues.append(
                {
                    "startSeconds": round(start_seconds, 3),
                    "endSeconds": round(end_seconds, 3),
                    "text": cue_text,
                }
            )
        current.clear()

    for token in tokens:
        current.append(token)
        if token.text.strip().endswith(SENTENCE_ENDINGS):
            flush()
    flush()
    return cues


def _is_punctuation_character(character: str) -> bool:
    return bool(character) and unicodedata.category(character).startswith("P")


def _text_without_punctuation(value: str) -> str:
    restorable_punctuation = frozenset("，。！？；：、,.!?;:")
    return "".join(
        character
        for character in value
        if character not in restorable_punctuation
    ).strip()


def _canonical_lexical_text(value: str) -> str:
    return "".join(
        character.casefold()
        for character in value
        if not character.isspace() and not _is_punctuation_character(character)
    )


def _timed_lexical_characters(
    tokens: list[TimedSubtitleToken],
) -> list[TimedSubtitleToken]:
    characters: list[TimedSubtitleToken] = []
    for token in tokens:
        lexical_characters = [
            character
            for character in token.text
            if not character.isspace()
            and not _is_punctuation_character(character)
        ]
        if not lexical_characters:
            continue
        duration = max(0.01, token.end_seconds - token.start_seconds)
        for index, character in enumerate(lexical_characters):
            start_seconds = (
                token.start_seconds + duration * index / len(lexical_characters)
            )
            end_seconds = (
                token.start_seconds
                + duration * (index + 1) / len(lexical_characters)
            )
            characters.append(
                TimedSubtitleToken(character, start_seconds, end_seconds)
            )
    return characters


def _subtitle_cues_from_repunctuated_text(
    tokens: list[TimedSubtitleToken],
    repunctuated_text: str,
    duration_seconds: float,
) -> list[dict[str, Any]]:
    timed_characters = _timed_lexical_characters(tokens)
    if (
        not timed_characters
        or _canonical_lexical_text(repunctuated_text)
        != "".join(character.text.casefold() for character in timed_characters)
    ):
        return []

    cues: list[dict[str, Any]] = []
    sentence_characters: list[str] = []
    sentence_start_index = 0
    lexical_cursor = 0

    def flush() -> None:
        nonlocal sentence_start_index
        sentence_text = "".join(sentence_characters).strip()
        if sentence_text and lexical_cursor > sentence_start_index:
            start_token = timed_characters[sentence_start_index]
            end_token = timed_characters[lexical_cursor - 1]
            cues.append(
                {
                    "startSeconds": round(
                        min(duration_seconds, start_token.start_seconds),
                        3,
                    ),
                    "endSeconds": round(
                        min(
                            duration_seconds,
                            max(start_token.start_seconds + 0.01, end_token.end_seconds),
                        ),
                        3,
                    ),
                    "text": sentence_text,
                }
            )
            sentence_start_index = lexical_cursor
        sentence_characters.clear()

    for character in repunctuated_text:
        sentence_characters.append(character)
        if (
            not character.isspace()
            and not _is_punctuation_character(character)
        ):
            lexical_cursor += 1
        if character in SENTENCE_ENDINGS:
            flush()
    flush()
    return cues


def _sentence_info_cues(
    item: dict[str, Any],
    duration_seconds: float,
) -> list[dict[str, Any]]:
    raw_sentences = item.get("sentence_info")
    cues: list[dict[str, Any]] = []
    if not isinstance(raw_sentences, list):
        return cues
    for sentence in raw_sentences:
        if not isinstance(sentence, dict):
            continue
        sentence_text = str(sentence.get("text") or "").strip()
        start = sentence.get("start")
        end = sentence.get("end")
        if (
            sentence_text
            and isinstance(start, (int, float))
            and isinstance(end, (int, float))
        ):
            cues.append(
                {
                    "startSeconds": round(max(0.0, float(start) / 1000), 3),
                    "endSeconds": round(
                        min(duration_seconds, max(float(start), float(end)) / 1000),
                        3,
                    ),
                    "text": sentence_text,
                }
            )
    return cues


def _normalize_funasr_result(
    result: Any,
    duration_seconds: float,
    repunctuated_text: str | None = None,
    language: str = "auto",
) -> dict[str, Any]:
    item = result[0] if isinstance(result, list) and result else result
    if not isinstance(item, dict):
        raise RuntimeError("FunASR 返回了无效结果。")
    text = str(item.get("text") or "").strip()
    timed_tokens = _nano_timed_tokens(item, duration_seconds)
    if not timed_tokens:
        timed_tokens = _standard_timed_tokens(item, text, duration_seconds)
    repunctuated_cues = (
        _subtitle_cues_from_repunctuated_text(
            timed_tokens,
            repunctuated_text,
            duration_seconds,
        )
        if timed_tokens and repunctuated_text
        else []
    )
    if repunctuated_cues:
        text = repunctuated_text.strip()
        cues = repunctuated_cues
    else:
        cues = (
            _subtitle_cues_from_tokens(timed_tokens, duration_seconds)
            if timed_tokens
            else _sentence_info_cues(item, duration_seconds)
        )
    if not cues and text:
        cues.append(
            {
                "startSeconds": 0.0,
                "endSeconds": round(duration_seconds, 3),
                "text": text,
            }
        )
    return {
        "status": "ready" if text else "unavailable",
        "language": language,
        "text": text,
        "cues": cues,
        **({} if text else {"error": "没有识别到可辨语音。"}),
    }


def _dominant_transcript_language(text: str) -> str | None:
    hiragana_or_katakana = sum(
        1
        for character in text
        if "\u3040" <= character <= "\u30ff"
        or "\u31f0" <= character <= "\u31ff"
    )
    han = sum(1 for character in text if "\u3400" <= character <= "\u9fff")
    latin = sum(
        1
        for character in text
        if ("a" <= character.lower() <= "z")
    )
    if hiragana_or_katakana:
        return "ja"
    if han:
        return "zh"
    if latin:
        return "en"
    return None


def _filter_transcript_languages(
    transcript: dict[str, Any],
    languages: tuple[str, ...],
) -> dict[str, Any]:
    selected = tuple(dict.fromkeys(languages))
    if not selected or len(selected) == 3:
        transcript["language"] = "auto"
        return transcript
    transcript["language"] = ",".join(selected)
    # A single selected language is already supplied to Nano as a decoding
    # constraint. Filtering it again would incorrectly discard Japanese
    # sentences made only from Kanji.
    if len(selected) == 1:
        return transcript

    cues = [
        cue
        for cue in transcript.get("cues", [])
        if _dominant_transcript_language(str(cue.get("text") or ""))
        in selected
    ]
    transcript["cues"] = cues
    transcript["text"] = "".join(
        str(cue.get("text") or "").strip() for cue in cues
    ).strip()
    if not transcript["text"]:
        transcript["status"] = "unavailable"
        transcript["error"] = "没有识别到所选语言的字幕。"
    return transcript


def build_analysis_manifest(
    video_path: Path,
    output_dir: Path,
    duration_seconds: float,
    ffmpeg: str,
    *,
    include_keyframes: bool = True,
    on_progress: Callable[[str, float], None] | None = None,
) -> tuple[Path, dict[str, Any]]:
    report = on_progress or (lambda _stage, _progress: None)
    audio: dict[str, Any] | None = None
    frames = []
    if include_keyframes:
        report("extracting-audio", 0.05)
        audio_path, _wav_path = extract_analysis_audio(
            ffmpeg,
            video_path,
            output_dir,
        )
        audio = {
            "filename": audio_path.name,
            "mimeType": "audio/mpeg",
            "sizeBytes": audio_path.stat().st_size,
        }
        report("extracting-audio", 0.25)
        report("extracting-keyframes", 0.30)
        frames = extract_keyframes(video_path, output_dir, duration_seconds)
        report("extracting-keyframes", 0.92)
    else:
        report("direct-video-ready", 0.95)

    manifest = {
        "version": 1,
        "mode": "keyframes" if include_keyframes else "direct",
        "audio": audio,
        "frames": frames,
        # Qwen can start immediately. An independently installed transcription
        # backend may replace this pending state after the summary is ready.
        "transcript": {
            "status": "pending",
            "language": "zh",
            "text": "",
            "cues": [],
        },
    }
    manifest_path = output_dir / "analysis-manifest.json"
    manifest_path.write_text(
        json.dumps(manifest, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
    report("ready", 1.0)
    return manifest_path, manifest
