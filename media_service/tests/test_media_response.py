from __future__ import annotations

import tempfile
import time
import unittest
from pathlib import Path

from media_service.main import artifact_file_response


class MediaResponseTests(unittest.IsolatedAsyncioTestCase):
    async def test_inline_video_supports_byte_ranges(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            artifact = Path(temporary) / "artifact.mp4"
            artifact.write_bytes(b"0123456789")
            response = artifact_file_response(
                artifact,
                "video/mp4",
                "video.mp4",
                int(time.time()) + 600,
                as_download=False,
            )
            messages: list[dict[str, object]] = []

            async def receive() -> dict[str, object]:
                return {"type": "http.request", "body": b"", "more_body": False}

            async def send(message: dict[str, object]) -> None:
                messages.append(message)

            await response(
                {
                    "type": "http",
                    "asgi": {"version": "3.0"},
                    "http_version": "1.1",
                    "method": "GET",
                    "scheme": "http",
                    "path": "/artifact",
                    "raw_path": b"/artifact",
                    "query_string": b"",
                    "headers": [(b"range", b"bytes=2-5")],
                    "client": ("127.0.0.1", 12345),
                    "server": ("127.0.0.1", 8788),
                },
                receive,
                send,
            )

            start = messages[0]
            self.assertEqual(start["type"], "http.response.start")
            self.assertEqual(start["status"], 206)
            headers = {
                key.decode("latin-1").lower(): value.decode("latin-1")
                for key, value in start["headers"]  # type: ignore[union-attr]
            }
            self.assertEqual(headers["accept-ranges"], "bytes")
            self.assertEqual(headers["content-range"], "bytes 2-5/10")
            self.assertEqual(headers["content-length"], "4")
            self.assertTrue(headers["content-disposition"].startswith("inline;"))
            body = b"".join(
                message.get("body", b"")
                for message in messages[1:]
                if message["type"] == "http.response.body"
            )
            self.assertEqual(body, b"2345")

    def test_download_response_uses_attachment_disposition(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            artifact = Path(temporary) / "artifact.mp4"
            artifact.write_bytes(b"video")
            response = artifact_file_response(
                artifact,
                "video/mp4",
                "video.mp4",
                int(time.time()) + 600,
                as_download=True,
            )
            headers = {
                key.decode("latin-1").lower(): value.decode("latin-1")
                for key, value in response.raw_headers
            }
            self.assertTrue(headers["content-disposition"].startswith("attachment;"))
            self.assertEqual(headers["cache-control"], "private, no-store")


if __name__ == "__main__":
    unittest.main()
