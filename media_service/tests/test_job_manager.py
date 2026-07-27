from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import time
import unittest
import uuid
from pathlib import Path
from unittest.mock import AsyncMock, patch

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
        max_bytes=500 * 1024 * 1024,
        download_max_bytes=1024 * 1024 * 1024,
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

    def test_worker_process_forces_utf8_unbuffered_output(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            manager = JobManager(settings_for(Path(temporary)))
            command = manager._worker_command(
                JobRecord(
                    job_id="01111111-1111-4111-8111-111111111111",
                    bvid="BV1xx411c7mD",
                ),
            )
            self.assertEqual(
                command[:5],
                [sys.executable, "-I", "-u", "-X", "utf8=1"],
            )
            self.assertEqual(command[command.index("--variant") + 1], "preview")
            self.assertEqual(
                command[command.index("--direct-summary-max-seconds") + 1],
                "0",
            )
            self.assertEqual(
                command[command.index("--max-bytes") + 1],
                str(1024 * 1024 * 1024),
            )
            analysis_command = manager._worker_command(
                JobRecord(
                    job_id="01111111-1111-4111-8111-111111111111",
                    bvid="BV1xx411c7mD",
                    variant="analysis",
                    direct_summary_max_seconds=360,
                ),
            )
            self.assertEqual(
                analysis_command[analysis_command.index("--max-bytes") + 1],
                str(500 * 1024 * 1024),
            )
            self.assertEqual(
                analysis_command[
                    analysis_command.index("--direct-summary-max-seconds") + 1
                ],
                "360",
            )
            upload_command = manager._worker_command(
                JobRecord(
                    job_id="01111111-1111-4111-8111-111111111111",
                    source_kind="upload",
                    source_name="sample.mov",
                    variant="analysis",
                    direct_summary_max_seconds=120,
                ),
            )
            self.assertEqual(
                upload_command[upload_command.index("--source-kind") + 1],
                "upload",
            )
            self.assertEqual(
                upload_command[upload_command.index("--input-file") + 1],
                "source-media",
            )
            environment = manager._worker_environment()
            self.assertEqual(environment["PYTHONIOENCODING"], "utf-8")
            self.assertEqual(environment["PYTHONUTF8"], "1")

            completed = subprocess.run(
                [
                    *command[:5],
                    "-c",
                    "import sys; print(sys.stdout.encoding); print('下载失败🧪')",
                ],
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                check=True,
                timeout=10,
                shell=False,
            )
            self.assertEqual(
                completed.stdout.decode("utf-8").splitlines(),
                ["utf-8", "下载失败🧪"],
            )


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

    async def test_error_event_marks_failed_and_cleanup_preserves_error(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            manager = JobManager(settings_for(root))
            job_id = str(uuid.uuid4())
            job_dir = root / job_id
            job_dir.mkdir()
            manager._jobs[job_id] = JobRecord(
                job_id=job_id,
                bvid="BV1xx411c7mD",
                status="running",
                phase="downloading",
                progress=0.42,
                queue_slot_held=False,
            )
            manager._persist(manager._jobs[job_id])
            partial = job_dir / "partial-video.mp4"
            partial.write_bytes(b"partial")

            await manager._handle_worker_message(
                job_id,
                {
                    "event": "error",
                    "code": "DOWNLOAD_FAILED",
                    "message": "原始下载错误。",
                    "retryable": True,
                },
            )
            failed = await manager.get(job_id)
            self.assertEqual(failed.status if failed else None, "failed")
            self.assertEqual(
                failed.error.message if failed and failed.error else None,
                "原始下载错误。",
            )

            cleaned = await manager.cancel(job_id)
            self.assertEqual(cleaned.status if cleaned else None, "failed")
            self.assertEqual(
                cleaned.error.code if cleaned and cleaned.error else None,
                "DOWNLOAD_FAILED",
            )
            self.assertEqual(
                cleaned.error.message if cleaned and cleaned.error else None,
                "原始下载错误。",
            )
            self.assertFalse(partial.exists())
            persisted = JobRecord.from_disk(
                json.loads((job_dir / "job.json").read_text(encoding="utf-8"))
            )
            self.assertEqual(persisted.status, "failed")
            self.assertEqual(
                persisted.error.message if persisted.error else None,
                "原始下载错误。",
            )

    async def test_stop_purges_active_failed_job_and_preserves_error(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            manager = JobManager(settings_for(root))
            job_id = str(uuid.uuid4())
            job_dir = root / job_id
            job_dir.mkdir()
            fake_process = type("FakeProcess", (), {"returncode": None})()
            manager._jobs[job_id] = JobRecord(
                job_id=job_id,
                bvid="BV1xx411c7mD",
                status="failed",
                phase="downloading",
                progress=0.42,
                error=JobError("DOWNLOAD_FAILED", "原始下载错误。", True),
                queue_slot_held=False,
                process=fake_process,  # type: ignore[arg-type]
            )
            manager._persist(manager._jobs[job_id])
            partial = job_dir / "partial-video.mp4"
            partial.write_bytes(b"partial")

            with patch.object(
                manager,
                "_terminate_process",
                new_callable=AsyncMock,
            ) as terminate:
                await manager.stop()

            terminate.assert_awaited_once_with(fake_process)
            stopped = await manager.get(job_id)
            self.assertEqual(stopped.status if stopped else None, "failed")
            self.assertEqual(
                stopped.error.code if stopped and stopped.error else None,
                "DOWNLOAD_FAILED",
            )
            self.assertEqual(
                stopped.error.message if stopped and stopped.error else None,
                "原始下载错误。",
            )
            self.assertFalse(partial.exists())
            persisted = JobRecord.from_disk(
                json.loads((job_dir / "job.json").read_text(encoding="utf-8"))
            )
            self.assertEqual(persisted.status, "failed")
            self.assertEqual(
                persisted.error.message if persisted.error else None,
                "原始下载错误。",
            )

    async def test_cleanup_promotes_inflight_error_to_failed(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            manager = JobManager(settings_for(root))
            job_id = str(uuid.uuid4())
            job_dir = root / job_id
            job_dir.mkdir()
            fake_process = type("FakeProcess", (), {"returncode": None})()
            manager._jobs[job_id] = JobRecord(
                job_id=job_id,
                bvid="BV1xx411c7mD",
                status="running",
                phase="merging",
                progress=0.94,
                error=JobError("PROBE_FAILED", "媒体校验失败。", True),
                queue_slot_held=True,
                process=fake_process,  # type: ignore[arg-type]
            )
            manager._queued_slots = 1
            manager._persist(manager._jobs[job_id])
            partial = job_dir / "partial-video.mp4"
            partial.write_bytes(b"partial")

            with patch.object(
                manager,
                "_terminate_process",
                new_callable=AsyncMock,
            ) as terminate:
                cleaned = await manager.cancel(job_id)
            terminate.assert_awaited_once_with(fake_process)
            self.assertEqual(cleaned.status if cleaned else None, "failed")
            self.assertEqual(
                cleaned.error.code if cleaned and cleaned.error else None,
                "PROBE_FAILED",
            )
            self.assertEqual(
                cleaned.error.message if cleaned and cleaned.error else None,
                "媒体校验失败。",
            )
            self.assertEqual(manager._queued_slots, 0)
            self.assertFalse(partial.exists())

    async def test_failed_error_survives_ttl_expiration(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            manager = JobManager(settings_for(root))
            job_id = str(uuid.uuid4())
            job_dir = root / job_id
            job_dir.mkdir()
            manager._jobs[job_id] = JobRecord(
                job_id=job_id,
                bvid="BV1xx411c7mD",
                status="failed",
                phase="downloading",
                progress=0.42,
                updated_at=time.time() - 61,
                error=JobError("DOWNLOAD_FAILED", "原始下载错误。", True),
                queue_slot_held=False,
            )
            manager._persist(manager._jobs[job_id])
            partial = job_dir / "partial-video.mp4"
            partial.write_bytes(b"partial")

            await manager.cleanup_once()

            expired = await manager.get(job_id)
            self.assertEqual(expired.status if expired else None, "expired")
            self.assertEqual(
                expired.error.code if expired and expired.error else None,
                "DOWNLOAD_FAILED",
            )
            self.assertFalse(partial.exists())
            persisted = JobRecord.from_disk(
                json.loads((job_dir / "job.json").read_text(encoding="utf-8"))
            )
            self.assertEqual(persisted.status, "expired")
            self.assertEqual(
                persisted.error.message if persisted.error else None,
                "原始下载错误。",
            )

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

    async def test_restart_preserves_reported_worker_error(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            job_id = str(uuid.uuid4())
            job_dir = root / job_id
            job_dir.mkdir()
            job = JobRecord(
                job_id=job_id,
                bvid="BV1xx411c7mD",
                status="running",
                phase="downloading",
                progress=0.42,
                error=JobError("DOWNLOAD_FAILED", "原始下载错误。", True),
            )
            (job_dir / "job.json").write_text(
                json.dumps(job.to_disk(), ensure_ascii=False),
                encoding="utf-8",
            )
            partial = job_dir / "partial-video.mp4"
            partial.write_bytes(b"partial")

            manager = JobManager(settings_for(root))
            await manager._load_records()

            restored = await manager.get(job_id)
            self.assertEqual(restored.status if restored else None, "failed")
            self.assertEqual(
                restored.error.code if restored and restored.error else None,
                "DOWNLOAD_FAILED",
            )
            self.assertEqual(
                restored.error.message if restored and restored.error else None,
                "原始下载错误。",
            )
            self.assertFalse(partial.exists())


if __name__ == "__main__":
    unittest.main()
