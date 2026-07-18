from __future__ import annotations

import os
import unittest
from unittest.mock import patch

from media_service.service.config import Settings, parse_cors_origins


class CorsConfigTests(unittest.TestCase):
    def test_origins_are_exact_and_deduplicated(self) -> None:
        origins = parse_cors_origins(
            "https://example.com/, http://127.0.0.1:3000,https://example.com"
        )
        self.assertEqual(
            origins, ("https://example.com", "http://127.0.0.1:3000")
        )

    def test_wildcard_and_non_origin_values_are_rejected(self) -> None:
        invalid_values = (
            "*",
            "https://example.com/path",
            "https://user:pass@example.com",
            "file:///tmp/test",
        )
        for value in invalid_values:
            with self.subTest(value=value), self.assertRaises(RuntimeError):
                parse_cors_origins(value)

    def test_local_origins_and_150_mb_are_defaults(self) -> None:
        with patch.dict(os.environ, {}, clear=True):
            settings = Settings.from_env()
        self.assertEqual(
            settings.cors_origins,
            ("http://localhost:3000", "http://127.0.0.1:3000"),
        )
        self.assertEqual(settings.max_bytes, 150 * 1024 * 1024)
        self.assertEqual(settings.job_timeout_seconds, 1_200)
        self.assertTrue(settings.allow_tokenless_loopback)


if __name__ == "__main__":
    unittest.main()
