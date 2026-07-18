from __future__ import annotations

import tempfile
import time
import unittest
import uuid
from pathlib import Path

from media_service.service.security import (
    is_loopback_address,
    is_valid_bvid,
    safe_artifact_path,
    safe_job_dir,
    sign_download,
    verify_download_signature,
)


class SecurityTests(unittest.TestCase):
    def test_bvid_is_strict(self) -> None:
        self.assertTrue(is_valid_bvid("BV1xx411c7mD"))
        self.assertFalse(is_valid_bvid(" BV1xx411c7mD"))
        self.assertFalse(is_valid_bvid("https://b23.tv/BV1xx411c7mD"))
        self.assertFalse(is_valid_bvid("av123456"))
        self.assertFalse(is_valid_bvid("bv1xx411c7mD"))
        self.assertFalse(is_valid_bvid("BV1xx411c7mDextra"))

    def test_signed_download_rejects_tampering(self) -> None:
        secret = b"test-secret-that-is-not-used-in-production"
        job_id = str(uuid.uuid4())
        expires = int(time.time()) + 60
        signature = sign_download(secret, job_id, expires)
        self.assertTrue(
            verify_download_signature(secret, job_id, expires, signature)
        )
        self.assertFalse(
            verify_download_signature(secret, job_id, expires + 1, signature)
        )
        self.assertFalse(
            verify_download_signature(b"wrong", job_id, expires, signature)
        )
        self.assertFalse(
            verify_download_signature(secret, job_id, expires, "é")
        )
        self.assertFalse(
            verify_download_signature(secret, job_id, expires, "!" * 43)
        )

    def test_paths_stay_beneath_job_directory(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            job_id = str(uuid.uuid4())
            job_dir = safe_job_dir(root, job_id)
            job_dir.mkdir()
            self.assertEqual(safe_artifact_path(job_dir, "artifact.mp4").parent, job_dir)
            with self.assertRaises(ValueError):
                safe_job_dir(root, "../escape")
            with self.assertRaises(ValueError):
                safe_artifact_path(job_dir, "../escape.mp4")

    def test_loopback_detection(self) -> None:
        for host in ("127.0.0.1", "::1", "localhost"):
            self.assertTrue(is_loopback_address(host))
        self.assertFalse(is_loopback_address("192.168.1.10"))
        self.assertFalse(is_loopback_address(None))


if __name__ == "__main__":
    unittest.main()
