from __future__ import annotations

import base64
import hashlib
import hmac
import ipaddress
import re
from pathlib import Path


# A Bilibili BVID is exactly 12 ASCII alpha-numeric characters and starts with
# the case-sensitive "BV" prefix. URLs, AV ids and surrounding whitespace are
# deliberately rejected at the trust boundary.
BVID_RE = re.compile(r"^BV[0-9A-Za-z]{10}$", re.ASCII)
JOB_ID_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
    re.ASCII,
)
DOWNLOAD_SIGNATURE_RE = re.compile(r"^[A-Za-z0-9_-]{43}$", re.ASCII)


def is_valid_bvid(value: str) -> bool:
    return bool(BVID_RE.fullmatch(value))


def is_valid_job_id(value: str) -> bool:
    return bool(JOB_ID_RE.fullmatch(value))


def is_loopback_address(host: str | None) -> bool:
    if not host:
        return False
    normalized = host.strip("[]")
    try:
        return ipaddress.ip_address(normalized).is_loopback
    except ValueError:
        return normalized.lower() == "localhost"


def _signature_payload(job_id: str, expires: int) -> bytes:
    return f"{job_id}\n{expires}".encode("ascii")


def sign_download(secret: bytes, job_id: str, expires: int) -> str:
    digest = hmac.new(
        secret, _signature_payload(job_id, expires), hashlib.sha256
    ).digest()
    return base64.urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")


def verify_download_signature(
    secret: bytes, job_id: str, expires: int, signature: str
) -> bool:
    if not DOWNLOAD_SIGNATURE_RE.fullmatch(signature):
        return False
    expected = sign_download(secret, job_id, expires).encode("ascii")
    return hmac.compare_digest(expected, signature.encode("ascii"))


def safe_job_dir(state_root: Path, job_id: str) -> Path:
    if not is_valid_job_id(job_id):
        raise ValueError("invalid job id")
    root = state_root.resolve()
    candidate = (root / job_id).resolve()
    if candidate.parent != root:
        raise ValueError("job path escapes state root")
    return candidate


def safe_artifact_path(job_dir: Path, filename: str) -> Path:
    if not filename or filename != Path(filename).name:
        raise ValueError("invalid artifact filename")
    root = job_dir.resolve()
    candidate = (root / filename).resolve()
    if candidate.parent != root:
        raise ValueError("artifact path escapes job directory")
    return candidate
