"""FunASR Nano and CT-Punc backend, distributed separately from media core."""

from __future__ import annotations

import importlib.util
import os
import threading
from functools import lru_cache
from pathlib import Path
from typing import Any

from .analysis_pipeline import (
    _canonical_lexical_text,
    _dominant_transcript_language,
    _filter_transcript_languages,
    _normalize_funasr_result,
    _text_without_punctuation,
)


DEFAULT_FUNASR_MODEL = "FunAudioLLM/Fun-ASR-Nano-2512"
NANO_MODEL_MARKER = "fun-asr-nano"
MODELSCOPE_MODEL_ALIASES = {
    "fsmn-vad": "iic/speech_fsmn_vad_zh-cn-16k-common-pytorch",
    "ct-punc": "iic/punc_ct-transformer_cn-en-common-vocab471067-large",
}
_FUNASR_INFERENCE_LOCK = threading.Lock()


def is_available() -> bool:
    return all(
        importlib.util.find_spec(module_name) is not None
        for module_name in ("funasr", "modelscope", "torch")
    )


def _is_nano_model(model_name: str) -> bool:
    return NANO_MODEL_MARKER in model_name.lower()


def _prefer_cached_modelscope_model(model_name: str, hub: str) -> str:
    """Use an existing ModelScope snapshot without requiring a network check."""
    if hub.lower() not in {"ms", "modelscope"} or Path(model_name).exists():
        return model_name
    repository_id = MODELSCOPE_MODEL_ALIASES.get(model_name, model_name)
    try:
        from modelscope.hub.snapshot_download import snapshot_download

        return snapshot_download(repository_id, local_files_only=True)
    except Exception:
        return model_name


@lru_cache(maxsize=1)
def _load_funasr_model(
    model_name: str,
    vad_model: str,
    punc_model: str,
    device: str,
    hub: str,
) -> Any:
    from funasr import AutoModel

    cached_model_name = _prefer_cached_modelscope_model(model_name, hub)
    cached_vad_model = _prefer_cached_modelscope_model(vad_model, hub)
    model_options: dict[str, Any] = {
        "model": cached_model_name,
        "vad_model": cached_vad_model,
        "vad_kwargs": {"max_single_segment_time": 30_000},
        "device": device,
        "disable_update": True,
    }
    if hub:
        model_options["hub"] = hub
    if _is_nano_model(model_name):
        model_options["trust_remote_code"] = True
    elif punc_model:
        model_options["punc_model"] = punc_model
    return AutoModel(**model_options)


@lru_cache(maxsize=1)
def _load_funasr_punctuation_model(
    punc_model: str,
    device: str,
    hub: str,
) -> Any:
    from funasr import AutoModel

    model_options: dict[str, Any] = {
        "model": _prefer_cached_modelscope_model(punc_model, hub),
        "device": device,
        "disable_update": True,
    }
    if hub:
        model_options["hub"] = hub
    return AutoModel(**model_options)


def _funasr_result_text(result: Any) -> str:
    item = result[0] if isinstance(result, list) and result else result
    return str(item.get("text") or "").strip() if isinstance(item, dict) else ""


def _repunctuate_with_ct_punc(
    text: str,
    punc_model: str,
    device: str,
    hub: str,
) -> str | None:
    punctuation_input = _text_without_punctuation(text)
    if not punctuation_input or not punc_model:
        return None
    model = _load_funasr_punctuation_model(punc_model, device, hub)
    result = model.generate(input=punctuation_input)
    repunctuated_text = _funasr_result_text(result)
    return (
        repunctuated_text
        if _canonical_lexical_text(repunctuated_text)
        == _canonical_lexical_text(punctuation_input)
        else None
    )


def transcribe(
    wav_path: Path,
    duration_seconds: float,
    languages: tuple[str, ...] = (),
) -> dict[str, Any]:
    selected_languages = tuple(
        language
        for language in dict.fromkeys(languages)
        if language in {"zh", "ja", "en"}
    )
    language_names = {"zh": "中文", "ja": "日文", "en": "英文"}
    forced_language = (
        language_names[selected_languages[0]]
        if len(selected_languages) == 1
        else None
    )
    output_language = (
        selected_languages[0]
        if len(selected_languages) == 1
        else "auto"
    )
    try:
        model_name = os.getenv("FRAMENOTE_FUNASR_MODEL", DEFAULT_FUNASR_MODEL)
        punc_model = os.getenv("FRAMENOTE_FUNASR_PUNC_MODEL", "ct-punc")
        device = os.getenv("FRAMENOTE_FUNASR_DEVICE", "cpu")
        hub = os.getenv("FRAMENOTE_FUNASR_HUB", "ms")
        model = _load_funasr_model(
            model_name,
            os.getenv("FRAMENOTE_FUNASR_VAD_MODEL", "fsmn-vad"),
            punc_model,
            device,
            hub,
        )
        repunctuated_text = None
        with _FUNASR_INFERENCE_LOCK:
            if _is_nano_model(model_name):
                generation_options: dict[str, Any] = {
                    "input": str(wav_path),
                    "cache": {},
                    "batch_size": 1,
                    "use_itn": True,
                }
                if forced_language:
                    generation_options["language"] = forced_language
                result = model.generate(**generation_options)
                raw_text = _funasr_result_text(result)
                if _dominant_transcript_language(raw_text) != "ja":
                    try:
                        repunctuated_text = _repunctuate_with_ct_punc(
                            raw_text,
                            punc_model,
                            device,
                            hub,
                        )
                    except Exception:
                        repunctuated_text = None
            else:
                result = model.generate(
                    input=str(wav_path),
                    batch_size_s=300,
                    batch_size_threshold_s=60,
                    sentence_timestamp=True,
                )
        return _filter_transcript_languages(
            _normalize_funasr_result(
                result,
                duration_seconds,
                repunctuated_text,
                output_language,
            ),
            selected_languages,
        )
    except Exception as exc:
        return {
            "status": "unavailable",
            "language": output_language,
            "text": "",
            "cues": [],
            "error": f"FunASR 提取失败：{str(exc)[:240]}",
        }
