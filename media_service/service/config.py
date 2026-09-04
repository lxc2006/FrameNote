from __future__ import annotations

import os
import secrets
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlsplit


def _bounded_int(name: str, default: int, minimum: int, maximum: int) -> int:
    raw = os.getenv(name)
    if raw is None:
        return default
    try:
        value = int(raw)
    except ValueError as exc:
            raise RuntimeError(f"{name} must be an integer") from exc
    if not minimum <= value <= maximum:
        raise RuntimeError(f"{name} must be between {minimum} and {maximum}")
    return value


def _boolean(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    normalized = raw.strip().lower()
    if normalized in {"1", "true", "yes", "on"}:
        return True
    if normalized in {"0", "false", "no", "off"}:
        return False
    raise RuntimeError(f"{name} must be a boolean")


def parse_cors_origins(raw: str | None) -> tuple[str, ...]:
    if not raw:
        return ()
    origins: list[str] = []
    for item in raw.split(","):
        origin = item.strip().rstrip("/")
        if not origin:
            continue
        if origin == "null":
            if origin not in origins:
                origins.append(origin)
            continue
        if origin == "*":
            raise RuntimeError("FRAMENOTE_MEDIA_CORS_ORIGINS cannot contain a wildcard")
        parsed = urlsplit(origin)
        if (
            parsed.scheme not in {"http", "https"}
            or not parsed.netloc
            or parsed.path not in {"", "/"}
            or parsed.query
            or parsed.fragment
            or parsed.username
            or parsed.password
        ):
            raise RuntimeError(f"invalid CORS origin: {origin}")
        normalized = f"{parsed.scheme}://{parsed.netloc}"
        if normalized not in origins:
            origins.append(normalized)
    return tuple(origins)


def _public_base_url(raw: str | None) -> str | None:
    if not raw:
        return None
    value = raw.strip().rstrip("/")
    parsed = urlsplit(value)
    if (
        parsed.scheme not in {"http", "https"}
        or not parsed.netloc
        or parsed.path not in {"", "/"}
        or parsed.query
        or parsed.fragment
        or parsed.username
        or parsed.password
    ):
        raise RuntimeError("FRAMENOTE_MEDIA_PUBLIC_BASE_URL must be an HTTP(S) origin")
    return value


@dataclass(frozen=True, slots=True)
class Settings:
    state_root: Path
    api_token: str | None
    allow_tokenless_loopback: bool
    signing_secret: bytes
    signing_secret_is_ephemeral: bool
    cors_origins: tuple[str, ...]
    public_base_url: str | None
    concurrency: int
    max_queued: int
    max_duration_seconds: int
    max_bytes: int
    job_timeout_seconds: int
    artifact_ttl_seconds: int
    signed_url_ttl_seconds: int
    terminal_retention_seconds: int
    cleanup_interval_seconds: int

    @classmethod
    def from_env(cls) -> "Settings":
        service_root = Path(__file__).resolve().parent.parent
        state_root = Path(
            os.getenv("FRAMENOTE_MEDIA_STATE_DIR", str(service_root / "data"))
        ).expanduser().resolve()
        api_token = os.getenv("FRAMENOTE_MEDIA_API_TOKEN") or None
        raw_signing_secret = os.getenv("FRAMENOTE_MEDIA_SIGNING_SECRET")
        ephemeral = not raw_signing_secret
        signing_secret = (
            raw_signing_secret.encode("utf-8")
            if raw_signing_secret
            else secrets.token_bytes(32)
        )
        return cls(
            state_root=state_root,
            api_token=api_token,
            allow_tokenless_loopback=_boolean(
                "FRAMENOTE_MEDIA_ALLOW_TOKENLESS_LOOPBACK", True
            ),
            signing_secret=signing_secret,
            signing_secret_is_ephemeral=ephemeral,
            cors_origins=parse_cors_origins(
                os.getenv(
                    "FRAMENOTE_MEDIA_CORS_ORIGINS",
                    "http://localhost:3000,http://127.0.0.1:3000",
                )
            ),
            public_base_url=_public_base_url(
                os.getenv("FRAMENOTE_MEDIA_PUBLIC_BASE_URL")
            ),
            concurrency=2,
            max_queued=20,
            max_duration_seconds=3_600,
            max_bytes=_bounded_int(
                "FRAMENOTE_MEDIA_MAX_BYTES",
                500 * 1024 * 1024,
                1024 * 1024,
                500 * 1024 * 1024,
            ),
            job_timeout_seconds=_bounded_int(
                "FRAMENOTE_MEDIA_JOB_TIMEOUT_SECONDS", 1_200, 60, 7_200
            ),
            artifact_ttl_seconds=_bounded_int(
                "FRAMENOTE_MEDIA_ARTIFACT_TTL_SECONDS", 3_600, 60, 86_400
            ),
            signed_url_ttl_seconds=_bounded_int(
                "FRAMENOTE_MEDIA_SIGNED_URL_TTL_SECONDS", 600, 30, 3_600
            ),
            terminal_retention_seconds=_bounded_int(
                "FRAMENOTE_MEDIA_TERMINAL_RETENTION_SECONDS", 3_600, 60, 86_400
            ),
            cleanup_interval_seconds=_bounded_int(
                "FRAMENOTE_MEDIA_CLEANUP_INTERVAL_SECONDS", 60, 5, 3_600
            ),
        )
