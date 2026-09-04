"""Standalone entry point for the optional FrameNote subtitle extension."""

from __future__ import annotations

import argparse
import contextlib
import json
import os
import sys
from pathlib import Path


EXTENSION_VERSION = "1.0.0"
MODEL_DIRECTORIES = {
    "FRAMENOTE_FUNASR_MODEL": "fun-asr-nano",
    "FRAMENOTE_FUNASR_VAD_MODEL": "fsmn-vad",
    "FRAMENOTE_FUNASR_PUNC_MODEL": "ct-punc",
}


def _configure_streams() -> None:
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if callable(reconfigure):
            reconfigure(encoding="utf-8", errors="backslashreplace")


def _extension_root() -> Path:
    executable = Path(sys.executable if getattr(sys, "frozen", False) else __file__)
    return executable.resolve().parent


def _configure_models() -> dict[str, str]:
    models_root = Path(
        os.getenv(
            "FRAMENOTE_SUBTITLE_MODELS_DIR",
            str(_extension_root() / "models"),
        )
    ).expanduser().resolve()
    resolved: dict[str, str] = {}
    for variable, directory_name in MODEL_DIRECTORIES.items():
        model_path = (models_root / directory_name).resolve()
        if model_path.parent != models_root or not model_path.is_dir():
            raise RuntimeError(f"字幕模型目录缺失：{directory_name}")
        os.environ[variable] = str(model_path)
        resolved[directory_name] = str(model_path)
    os.environ.setdefault("FRAMENOTE_FUNASR_HUB", "ms")
    os.environ.setdefault("FRAMENOTE_FUNASR_DEVICE", "cpu")
    return resolved


def _installed_version() -> str:
    descriptor_path = _extension_root() / "extension.json"
    try:
        descriptor = json.loads(descriptor_path.read_text(encoding="utf-8"))
        version = descriptor.get("version") if isinstance(descriptor, dict) else None
        return version if isinstance(version, str) and version else EXTENSION_VERSION
    except Exception:
        return EXTENSION_VERSION


def _write_json(value: object) -> None:
    sys.stdout.write(json.dumps(value, ensure_ascii=True, separators=(",", ":")))
    sys.stdout.write("\n")
    sys.stdout.flush()


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser()
    parser.add_argument("--health", action="store_true")
    parser.add_argument("--input")
    parser.add_argument("--duration", type=float)
    parser.add_argument("--languages", default="")
    return parser


def main() -> int:
    _configure_streams()
    arguments = _parser().parse_args()
    try:
        models = _configure_models()
        from media_service.transcription_funasr import is_available, transcribe

        if not is_available():
            raise RuntimeError("字幕扩展依赖不完整。")
        if arguments.health:
            _write_json(
                {
                    "status": "ok",
                    "service": "framenote-subtitles",
                    "version": _installed_version(),
                    "models": sorted(models),
                }
            )
            return 0

        if arguments.duration is None or not 0 < arguments.duration <= 3_600:
            raise RuntimeError("视频时长无效。")
        input_path = Path(arguments.input or "").expanduser().resolve()
        if (
            not input_path.is_file()
            or input_path.is_symlink()
            or input_path.suffix.lower() != ".wav"
        ):
            raise RuntimeError("字幕音轨无效。")
        languages = tuple(
            item for item in arguments.languages.split(",") if item in {"zh", "ja", "en"}
        )
        with contextlib.redirect_stdout(sys.stderr):
            result = transcribe(input_path, arguments.duration, languages)
        _write_json(result)
        return 0
    except Exception as exc:
        sys.stderr.write(f"{str(exc)[:500]}\n")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
