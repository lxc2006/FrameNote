from __future__ import annotations

import asyncio
import ipaddress
import io
import os
import re
import socket
from dataclasses import dataclass
from urllib.parse import urljoin, urlsplit

import httpx
import trafilatura
from pypdf import PdfReader

from .service.models import WebExtractResponse


MAX_REDIRECTS = 5
MAX_HTML_BYTES = 5 * 1024 * 1024
MAX_PDF_BYTES = 20 * 1024 * 1024
MAX_EXTRACTED_CHARACTERS = 180_000
MIN_READABLE_CHARACTERS = 160
DEFAULT_TIMEOUT_SECONDS = 12
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/126.0 Safari/537.36 FrameNote/1.0"
)
JS_REQUIRED_PATTERN = re.compile(
    r"(?:enable javascript|javascript is required|please turn on javascript|"
    r"requires javascript|id=[\"'](?:root|app|__next)[\"'][^>]*>\s*</)",
    re.IGNORECASE,
)
LOGIN_OR_CHALLENGE_PATTERN = re.compile(
    r"(?:sign in to continue|log in to continue|verify you are human|"
    r"checking your browser|access denied|captcha)",
    re.IGNORECASE,
)


@dataclass(slots=True)
class FetchedBody:
    requested_url: str
    final_url: str
    content_type: str
    body: bytes
    encoding: str


def _bounded_timeout() -> int:
    raw = os.getenv("FRAMENOTE_WEB_FETCH_TIMEOUT_SECONDS")
    if raw is None:
        return DEFAULT_TIMEOUT_SECONDS
    try:
        value = int(raw)
    except ValueError:
        return DEFAULT_TIMEOUT_SECONDS
    return min(30, max(3, value))


def _is_public_address(value: str) -> bool:
    address = ipaddress.ip_address(value)
    return not (
        address.is_private
        or address.is_loopback
        or address.is_link_local
        or address.is_multicast
        or address.is_reserved
        or address.is_unspecified
    )


async def _validate_public_url(value: str) -> str:
    parsed = urlsplit(value)
    if (
        parsed.scheme not in {"http", "https"}
        or not parsed.hostname
        or parsed.username
        or parsed.password
        or parsed.port not in {None, 80, 443}
    ):
        raise ValueError("只允许不含账号信息的公开 HTTP(S) 网页。")

    hostname = parsed.hostname.rstrip(".").lower()
    if hostname == "localhost" or hostname.endswith(".local"):
        raise ValueError("不允许访问本机或局域网地址。")

    try:
        literal = ipaddress.ip_address(hostname)
    except ValueError:
        literal = None
    if literal is not None:
        if not _is_public_address(str(literal)):
            raise ValueError("不允许访问本机或局域网地址。")
        return value

    try:
        records = await asyncio.to_thread(
            socket.getaddrinfo,
            hostname,
            parsed.port or (443 if parsed.scheme == "https" else 80),
            type=socket.SOCK_STREAM,
        )
    except socket.gaierror as exc:
        raise ValueError("网页域名无法解析。") from exc
    addresses = {record[4][0] for record in records}
    if not addresses or any(not _is_public_address(address) for address in addresses):
        raise ValueError("网页域名解析到了非公开网络地址。")
    return value


def _skipped(
    requested_url: str,
    code: str,
    message: str,
    *,
    final_url: str | None = None,
    requires_browser: bool = False,
) -> WebExtractResponse:
    return WebExtractResponse(
        status="requires_browser" if requires_browser else "skipped",
        url=requested_url,
        finalUrl=final_url,
        errorCode=code,
        errorMessage=message,
    )


async def _read_limited(response: httpx.Response, limit: int) -> bytes:
    declared_size = response.headers.get("content-length")
    if declared_size:
        try:
            if int(declared_size) > limit:
                raise ValueError("网页响应体超过大小上限。")
        except ValueError as exc:
            if str(exc) == "网页响应体超过大小上限。":
                raise

    chunks: list[bytes] = []
    size = 0
    async for chunk in response.aiter_bytes():
        size += len(chunk)
        if size > limit:
            raise ValueError("网页响应体超过大小上限。")
        chunks.append(chunk)
    return b"".join(chunks)


async def _fetch(value: str) -> FetchedBody | WebExtractResponse:
    requested_url = value
    current_url = value
    timeout = httpx.Timeout(_bounded_timeout())
    headers = {
        "accept": "text/html,application/xhtml+xml,application/pdf;q=0.9,*/*;q=0.5",
        "accept-language": "zh-CN,zh;q=0.9,en;q=0.7",
        "user-agent": USER_AGENT,
    }

    async with httpx.AsyncClient(
        follow_redirects=False,
        timeout=timeout,
        headers=headers,
    ) as client:
        for _ in range(MAX_REDIRECTS + 1):
            try:
                await _validate_public_url(current_url)
            except (ValueError, OSError) as exc:
                return _skipped(
                    requested_url,
                    "URL_NOT_PUBLIC",
                    str(exc),
                    final_url=current_url,
                )

            try:
                async with client.stream("GET", current_url) as response:
                    if response.status_code in {301, 302, 303, 307, 308}:
                        location = response.headers.get("location")
                        if not location:
                            return _skipped(
                                requested_url,
                                "INVALID_REDIRECT",
                                "网页返回了缺少目标地址的重定向。",
                                final_url=current_url,
                            )
                        current_url = urljoin(current_url, location)
                        continue
                    if response.status_code in {401, 403, 407, 429}:
                        return _skipped(
                            requested_url,
                            "ACCESS_DENIED",
                            "网页需要登录、验证或拒绝了自动访问。",
                            final_url=current_url,
                        )
                    if response.status_code < 200 or response.status_code >= 300:
                        return _skipped(
                            requested_url,
                            "HTTP_ERROR",
                            f"网页返回 HTTP {response.status_code}。",
                            final_url=current_url,
                        )

                    content_type = response.headers.get("content-type", "").lower()
                    is_pdf = (
                        "application/pdf" in content_type
                        or urlsplit(current_url).path.lower().endswith(".pdf")
                    )
                    try:
                        body = await _read_limited(
                            response,
                            MAX_PDF_BYTES if is_pdf else MAX_HTML_BYTES,
                        )
                    except ValueError as exc:
                        return _skipped(
                            requested_url,
                            "BODY_TOO_LARGE",
                            str(exc),
                            final_url=current_url,
                        )
                    return FetchedBody(
                        requested_url=requested_url,
                        final_url=current_url,
                        content_type=content_type,
                        body=body,
                        encoding=response.encoding or "utf-8",
                    )
            except (httpx.TimeoutException, httpx.NetworkError):
                return _skipped(
                    requested_url,
                    "FETCH_FAILED",
                    "网页连接失败或读取超时。",
                    final_url=current_url,
                )

    return _skipped(
        requested_url,
        "TOO_MANY_REDIRECTS",
        "网页重定向次数过多。",
        final_url=current_url,
    )


def _extract_pdf(fetched: FetchedBody) -> WebExtractResponse:
    try:
        reader = PdfReader(io.BytesIO(fetched.body))
        text = "\n\n".join(
            page.extract_text() or "" for page in reader.pages[:200]
        ).strip()
        title = None
        if reader.metadata and reader.metadata.title:
            title = str(reader.metadata.title).strip()[:300] or None
    except Exception:
        return _skipped(
            fetched.requested_url,
            "PDF_PARSE_FAILED",
            "PDF 正文解析失败。",
            final_url=fetched.final_url,
        )
    if len(text) < MIN_READABLE_CHARACTERS:
        return _skipped(
            fetched.requested_url,
            "PDF_NO_TEXT",
            "PDF 没有足够的可提取文本，可能是扫描件。",
            final_url=fetched.final_url,
        )
    return WebExtractResponse(
        status="ok",
        url=fetched.requested_url,
        finalUrl=fetched.final_url,
        title=title,
        contentType="application/pdf",
        text=text[:MAX_EXTRACTED_CHARACTERS],
        method="pypdf",
    )


def _extract_html(fetched: FetchedBody) -> WebExtractResponse:
    html = fetched.body.decode(fetched.encoding, errors="replace")
    metadata = trafilatura.extract_metadata(html, default_url=fetched.final_url)
    text = (
        trafilatura.extract(
            html,
            url=fetched.final_url,
            output_format="txt",
            include_comments=False,
            include_tables=True,
            favor_precision=True,
        )
        or ""
    ).strip()
    title = metadata.title.strip()[:300] if metadata and metadata.title else None
    published_at = (
        str(metadata.date).strip()[:80]
        if metadata and metadata.date
        else None
    )
    if LOGIN_OR_CHALLENGE_PATTERN.search(html[:100_000]) and len(text) < 600:
        return _skipped(
            fetched.requested_url,
            "ACCESS_DENIED",
            "网页需要登录或通过反爬验证。",
            final_url=fetched.final_url,
        )
    if len(text) < MIN_READABLE_CHARACTERS:
        return _skipped(
            fetched.requested_url,
            "REQUIRES_BROWSER",
            (
                "网页需要 JavaScript 渲染。"
                if JS_REQUIRED_PATTERN.search(html[:100_000])
                else "静态响应没有足够正文，将尝试浏览器渲染。"
            ),
            final_url=fetched.final_url,
            requires_browser=True,
        )
    return WebExtractResponse(
        status="ok",
        url=fetched.requested_url,
        finalUrl=fetched.final_url,
        title=title,
        publishedAt=published_at,
        contentType=fetched.content_type or "text/html",
        text=text[:MAX_EXTRACTED_CHARACTERS],
        method="trafilatura",
    )


async def extract_web_document(value: str) -> WebExtractResponse:
    fetched = await _fetch(value.strip())
    if isinstance(fetched, WebExtractResponse):
        return fetched
    if (
        "application/pdf" in fetched.content_type
        or fetched.body[:5] == b"%PDF-"
        or urlsplit(fetched.final_url).path.lower().endswith(".pdf")
    ):
        return await asyncio.to_thread(_extract_pdf, fetched)
    return await asyncio.to_thread(_extract_html, fetched)
