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

    def test_local_origins_and_variant_size_limits_are_defaults(self) -> None:
        with patch.dict(os.environ, {}, clear=True):
            settings = Settings.from_env()
        self.assertEqual(
            settings.cors_origins,
            ("http://localhost:3000", "http://127.0.0.1:3000"),
        )
        self.assertEqual(settings.max_bytes, 500 * 1024 * 1024)
        self.assertEqual(settings.download_max_bytes, 1024 * 1024 * 1024)
        self.assertEqual(settings.job_timeout_seconds, 1_200)
        self.assertTrue(settings.allow_tokenless_loopback)

    def test_analysis_limit_accepts_500_mb_and_rejects_larger_values(self) -> None:
        limit = 500 * 1024 * 1024
        with patch.dict(
            os.environ,
            {"FRAMENOTE_MEDIA_MAX_BYTES": str(limit)},
            clear=True,
        ):
            self.assertEqual(Settings.from_env().max_bytes, limit)

        with patch.dict(
            os.environ,
            {"FRAMENOTE_MEDIA_MAX_BYTES": str(limit + 1)},
            clear=True,
        ):
            with self.assertRaises(RuntimeError):
                Settings.from_env()


if __name__ == "__main__":
    unittest.main()
