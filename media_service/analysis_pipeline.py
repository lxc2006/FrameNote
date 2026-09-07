from __future__ import annotations

import json
import math
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable


MAX_KEYFRAMES = 64
MAX_SCENE_TARGETS = 80
PHASH_DUPLICATE_DISTANCE = 8


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


def _run_ffmpeg(command: list[str], error_message: str) -> None:
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
        raise RuntimeError(error_message)


def extract_analysis_audio(
    ffmpeg: str,
    video_path: Path,
    output_dir: Path,
    duration_seconds: float,
) -> tuple[Path, list[dict[str, Any]]]:
    """Create the summary audio plus API-sized chunks; no speech model runs locally."""
    mp3_path = output_dir / "analysis-audio.mp3"
    _run_ffmpeg(
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
        "FFmpeg 无法提取分析音轨。",
    )

    chunk_seconds = 285.0
    if duration_seconds <= chunk_seconds:
        return mp3_path, [
            {
                "filename": mp3_path.name,
                "mimeType": "audio/mpeg",
                "sizeBytes": mp3_path.stat().st_size,
                "startSeconds": 0.0,
                "endSeconds": round(duration_seconds, 3),
            }
        ]

    segment_list = output_dir / "analysis-asr-chunks.csv"
    segment_template = output_dir / "analysis-asr-%03d.mp3"
    _run_ffmpeg(
        [
            ffmpeg,
            "-v",
            "error",
            "-i",
            str(mp3_path),
            "-map",
            "0:a:0",
            "-c",
            "copy",
            "-f",
            "segment",
            "-segment_time",
            str(chunk_seconds),
            "-segment_list_type",
            "csv",
            "-segment_list",
            str(segment_list),
            "-reset_timestamps",
            "1",
            "-y",
            str(segment_template),
        ],
        "FFmpeg 无法切分在线字幕音轨。",
    )

    chunks: list[dict[str, Any]] = []
    try:
        import csv

        with segment_list.open("r", encoding="utf-8", newline="") as handle:
            rows = list(csv.reader(handle))
        for row in rows:
            if len(row) < 3:
                raise RuntimeError("在线字幕音轨清单无效。")
            candidate = Path(row[0])
            if not candidate.is_absolute():
                candidate = output_dir / candidate
            chunk_path = candidate.resolve()
            if chunk_path.parent != output_dir.resolve():
                raise RuntimeError("在线字幕音轨路径无效。")
            start_seconds = max(0.0, float(row[1]))
            end_seconds = min(duration_seconds, float(row[2]))
            if (
                not chunk_path.is_file()
                or chunk_path.is_symlink()
                or end_seconds <= start_seconds
                or end_seconds - start_seconds > 300.5
            ):
                raise RuntimeError("在线字幕音轨分片无效。")
            chunks.append(
                {
                    "filename": chunk_path.name,
                    "mimeType": "audio/mpeg",
                    "sizeBytes": chunk_path.stat().st_size,
                    "startSeconds": round(start_seconds, 3),
                    "endSeconds": round(end_seconds, 3),
                }
            )
    finally:
        segment_list.unlink(missing_ok=True)

    if not chunks:
        raise RuntimeError("没有生成在线字幕音轨。")
    return mp3_path, chunks


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
    report("extracting-audio", 0.05)
    audio_path, transcription_audio = extract_analysis_audio(
        ffmpeg,
        video_path,
        output_dir,
        duration_seconds,
    )
    audio = {
        "filename": audio_path.name,
        "mimeType": "audio/mpeg",
        "sizeBytes": audio_path.stat().st_size,
    }
    report("extracting-audio", 0.25)

    frames = []
    if include_keyframes:
        report("extracting-keyframes", 0.30)
        frames = extract_keyframes(video_path, output_dir, duration_seconds)
        report("extracting-keyframes", 0.92)
    else:
        report("direct-video-ready", 0.95)

    manifest = {
        "version": 1,
        "mode": "keyframes" if include_keyframes else "direct",
        "audio": audio,
        "transcriptionAudio": transcription_audio,
        "frames": frames,
    }
    manifest_path = output_dir / "analysis-manifest.json"
    manifest_path.write_text(
        json.dumps(manifest, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
    report("ready", 1.0)
    return manifest_path, manifest
