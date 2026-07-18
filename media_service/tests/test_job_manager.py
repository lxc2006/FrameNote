from __future__ import annotations

import tempfile
import json
import unittest
import uuid
from pathlib import Path

from media_service.service.config import Settings
from media_service.service.job_manager import (
    JobError,
    JobManager,
    JobRecord,
    QueueCapacityError,
)


def settings_for(root: Path, max_queued: int = 2) -> Settings:
    return Settings(
        state_root=root,
        api_token=None,
        allow_tokenless_loopback=True,
        signing_secret=b"test-secret",
        signing_secret_is_ephemeral=False,
        cors_origins=(),
        public_base_url=None,
        concurrency=2,
        max_queued=max_queued,
        max_duration_seconds=3_600,
        max_bytes=300 * 1024 * 1024,
        job_timeout_seconds=60,
        artifact_ttl_seconds=60,
        signed_url_ttl_seconds=30,
        terminal_retention_seconds=60,
        cleanup_interval_seconds=60,
    )


class JobRecordTests(unittest.TestCase):
    def test_persistence_never_serializes_process_handle(self) -> None:
        job = JobRecord(
            job_id="01111111-1111-4111-8111-111111111111",
            bvid="BV1xx411c7mD",
            error=JobError("TEST", "test", False),
            process=object(),  # type: ignore[arg-type]
        )
        value = job.to_disk()
        self.assertNotIn("process", value)
        restored = JobRecord.from_disk(value)
        self.assertEqual(restored.error.code if restored.error else None, "TEST")


class QueueTests(unittest.IsolatedAsyncioTestCase):
    async def test_queue_limit_and_cancelled_slot_release(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            manager = JobManager(settings_for(Path(temporary)))
            first = await manager.create("BV1xx411c7mD")
            await manager.create("BV1Q541167Qg")
            with self.assertRaises(QueueCapacityError):
                await manager.create("BV17x411w7KC")
            cancelled = await manager.cancel(first.job_id)
            self.assertEqual(cancelled.status if cancelled else None, "cancelled")
            third = await manager.create("BV17x411w7KC")
            self.assertEqual(third.status, "queued")

    async def test_restart_marks_interrupted_job_failed_and_purges_media(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            job_id = str(uuid.uuid4())
            job_dir = root / job_id
            job_dir.mkdir()
            job = JobRecord(job_id=job_id, bvid="BV1xx411c7mD")
            (job_dir / "job.json").write_text(
                json.dumps(job.to_disk()), encoding="utf-8"
            )
            artifact = job_dir / "partial-video.mp4"
            artifact.write_bytes(b"partial")

            manager = JobManager(settings_for(root))
            await manager._load_records()

            restored = await manager.get(job_id)
            self.assertEqual(restored.status if restored else None, "failed")
            self.assertEqual(
                restored.error.code if restored and restored.error else None,
                "SERVICE_RESTARTED",
            )
            self.assertFalse(artifact.exists())
            self.assertTrue((job_dir / "job.json").is_file())


if __name__ == "__main__":
    unittest.main()
