"""Optional transcription backend boundary used by the media core."""

from __future__ import annotations

import importlib
import json
import os
import subprocess
from pathlib import Path
from types import ModuleType
from typing import Any

from .analysis_pipeline import extract_funasr_audio


DEFAULT_BACKEND_MODULE = "media_service.transcription_funasr"
TRANSCRIPTION_NOT_INSTALLED = "字幕扩展未安装；视频总结仍可正常使用。"
EXTENSION_TIMEOUT_SECONDS = 3_600


def _backend_module_name() -> str:
    return os.getenv(
        "FRAMENOTE_TRANSCRIPTION_BACKEND",
        DEFAULT_BACKEND_MODULE,
    ).strip()


def _load_backend() -> ModuleType | None:
    module_name = _backend_module_name()
    if not module_name:
        return None
    try:
        backend = importlib.import_module(module_name)
    except (ImportError, ModuleNotFoundError):
        return None
    availability_check = getattr(backend, "is_available", None)
    if not callable(availability_check) or not availability_check():
        return None
    return backend


def _extension_executable() -> Path | None:
    raw_path = os.getenv("FRAMENOTE_TRANSCRIPTION_EXECUTABLE", "").strip()
    if not raw_path:
        return None
    executable = Path(raw_path).expanduser().resolve()
    if (
        not executable.is_file()
        or executable.is_symlink()
        or executable.suffix.lower() != ".exe"
    ):
        return None
    return executable


def transcription_available() -> bool:
    return _extension_executable() is not None or _load_backend() is not None


def _unavailable_transcript(languages: tuple[str, ...], error: str) -> dict[str, Any]:
    return {
        "status": "unavailable",
        "language": ",".join(languages) if languages else "auto",
        "text": "",
        "cues": [],
        "error": error,
    }


def _run_extension(
    executable: Path,
    wav_path: Path,
    duration_seconds: float,
    languages: tuple[str, ...],
) -> dict[str, Any]:
    command = [
        str(executable),
        "--input",
        str(wav_path),
        "--duration",
        str(duration_seconds),
        "--languages",
        ",".join(languages),
    ]
    creation_flags = (
        subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
    )
    completed = subprocess.run(
        command,
        check=False,
        capture_output=True,
        encoding="utf-8",
        errors="strict",
        timeout=EXTENSION_TIMEOUT_SECONDS,
        creationflags=creation_flags,
    )
    if completed.returncode != 0:
        detail = completed.stderr.strip()[-240:]
        raise RuntimeError(detail or "字幕扩展进程执行失败。")
    payload = json.loads(completed.stdout)
    if (
        not isinstance(payload, dict)
        or payload.get("status") not in {"ready", "unavailable"}
        or not isinstance(payload.get("text"), str)
        or not isinstance(payload.get("cues"), list)
    ):
        raise RuntimeError("字幕扩展返回了无效结果。")
    return payload


def complete_analysis_transcript(
    output_dir: Path,
    duration_seconds: float,
    video_path: Path | None = None,
    ffmpeg: str | None = None,
    languages: tuple[str, ...] = (),
) -> dict[str, Any]:
    """Run an optional backend and atomically update the analysis manifest."""
    manifest_path = output_dir / "analysis-manifest.json"
    if (
        not manifest_path.is_file()
        or manifest_path.is_symlink()
        or manifest_path.stat().st_size > 2 * 1024 * 1024
    ):
        raise RuntimeError("分析清单不存在或无效。")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if not isinstance(manifest, dict) or manifest.get("version") != 1:
        raise RuntimeError("分析清单版本无效。")
    current = manifest.get("transcript")
    if (
        isinstance(current, dict)
        and current.get("status") in {"ready", "unavailable"}
    ):
        return current

    extension_executable = _extension_executable()
    backend = None if extension_executable else _load_backend()
    wav_path = output_dir / "analysis-asr.wav"
    try:
        if extension_executable is None and backend is None:
            transcript = _unavailable_transcript(
                languages,
                TRANSCRIPTION_NOT_INSTALLED,
            )
        else:
            if not wav_path.is_file() and video_path is not None and ffmpeg:
                wav_path = extract_funasr_audio(ffmpeg, video_path, output_dir)
            if not wav_path.is_file() or wav_path.is_symlink():
                raise RuntimeError("字幕识别音轨不存在。")
            if extension_executable is not None:
                transcript = _run_extension(
                    extension_executable,
                    wav_path,
                    duration_seconds,
                    languages,
                )
            else:
                transcribe = getattr(backend, "transcribe")
                transcript = transcribe(wav_path, duration_seconds, languages)
    except Exception as exc:
        transcript = _unavailable_transcript(
            languages,
            f"字幕提取失败：{str(exc)[:240]}",
        )
    finally:
        wav_path.unlink(missing_ok=True)

    manifest["transcript"] = transcript
    temporary_path = output_dir / "analysis-manifest.json.tmp"
    temporary_path.write_text(
        json.dumps(manifest, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
    os.replace(temporary_path, manifest_path)
    return transcript
