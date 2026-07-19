from __future__ import annotations

import asyncio
import json
import logging
import math
import os
import signal
import shutil
import subprocess
import sys
import time
import uuid
from dataclasses import dataclass, field, fields, replace
from pathlib import Path
from typing import Any

from .config import Settings
from .security import is_valid_bvid, is_valid_job_id, safe_artifact_path, safe_job_dir


LOGGER = logging.getLogger("media_service.jobs")
PHASE_SEQUENCE = ("queued", "resolving", "downloading", "merging", "ready")
VALID_PHASES = set(PHASE_SEQUENCE)
PHASE_ORDER = {name: index for index, name in enumerate(PHASE_SEQUENCE)}
TERMINAL_STATUSES = {"succeeded", "failed", "cancelled", "expired"}
WORKER_PYTHON_OPTIONS = ("-I", "-u", "-X", "utf8=1")


class QueueCapacityError(RuntimeError):
    pass


@dataclass(slots=True)
class JobError:
    code: str
    message: str
    retryable: bool


@dataclass(slots=True)
class JobRecord:
    job_id: str
    bvid: str
    status: str = "queued"
    phase: str = "queued"
    progress: float = 0.0
    created_at: float = field(default_factory=time.time)
    updated_at: float = field(default_factory=time.time)
    title: str | None = None
    duration_seconds: float | None = None
    artifact_file: str | None = None
    artifact_filename: str | None = None
    artifact_mime_type: str | None = None
    artifact_size_bytes: int | None = None
    artifact_sha256: str | None = None
    artifact_expires_at: float | None = None
    error: JobError | None = None
    queue_slot_held: bool = True
    process: asyncio.subprocess.Process | None = field(default=None, repr=False)

    def to_disk(self) -> dict[str, Any]:
        value = {
            item.name: getattr(self, item.name)
            for item in fields(self)
            if item.name not in {"process", "error"}
        }
        if self.error:
            value["error"] = {
                "code": self.error.code,
                "message": self.error.message,
                "retryable": self.error.retryable,
            }
        else:
            value["error"] = None
        return {"version": 1, **value}

    @classmethod
    def from_disk(cls, value: dict[str, Any]) -> "JobRecord":
        value = dict(value)
        value.pop("version", None)
        allowed = {field_name for field_name in cls.__dataclass_fields__ if field_name != "process"}
        value = {key: item for key, item in value.items() if key in allowed}
        if isinstance(value.get("error"), dict):
            value["error"] = JobError(**value["error"])
        value["process"] = None
        return cls(**value)


class JobManager:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self._jobs: dict[str, JobRecord] = {}
        self._queue: asyncio.Queue[str] = asyncio.Queue()
        self._queued_slots = 0
        self._lock = asyncio.Lock()
        self._worker_tasks: list[asyncio.Task[None]] = []
        self._cleanup_task: asyncio.Task[None] | None = None
        self._stopping = False
        self._worker_script = Path(__file__).resolve().parent.parent / "worker.py"

    async def start(self) -> None:
        self.settings.state_root.mkdir(parents=True, exist_ok=True)
        await self._load_records()
        self._worker_tasks = [
            asyncio.create_task(self._consumer(index), name=f"media-worker-{index}")
            for index in range(self.settings.concurrency)
        ]
        self._cleanup_task = asyncio.create_task(
            self._cleanup_loop(), name="media-cleanup"
        )

    async def stop(self) -> None:
        self._stopping = True
        if self._cleanup_task:
            self._cleanup_task.cancel()
        processes: list[asyncio.subprocess.Process] = []
        purge_ids: list[str] = []
        async with self._lock:
            for job in self._jobs.values():
                active_process = (
                    job.process
                    if job.process and job.process.returncode is None
                    else None
                )
                if active_process:
                    processes.append(active_process)
                if job.status in {"queued", "running"}:
                    if job.queue_slot_held:
                        self._queued_slots = max(0, self._queued_slots - 1)
                        job.queue_slot_held = False
                    job.status = "failed"
                    if job.error is None:
                        job.error = JobError(
                            "SERVICE_STOPPED", "服务正在关闭，请重新提交任务。", True
                        )
                    job.updated_at = time.time()
                    self._persist(job)
                    purge_ids.append(job.job_id)
                elif active_process and (
                    job.status == "failed" or job.error is not None
                ):
                    purge_ids.append(job.job_id)
        await asyncio.gather(
            *(self._terminate_process(process) for process in processes),
            return_exceptions=True,
        )
        for task in self._worker_tasks:
            task.cancel()
        tasks: list[asyncio.Task[Any]] = [*self._worker_tasks]
        if self._cleanup_task:
            tasks.append(self._cleanup_task)
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        for job_id in purge_ids:
            self._purge_work_files(job_id)

    async def create(self, bvid: str) -> JobRecord:
        async with self._lock:
            if self._stopping:
                raise RuntimeError("service is stopping")
            if self._queued_slots >= self.settings.max_queued:
                raise QueueCapacityError("job queue is full")
            job_id = str(uuid.uuid4())
            job = JobRecord(job_id=job_id, bvid=bvid)
            job_dir = safe_job_dir(self.settings.state_root, job_id)
            job_dir.mkdir(parents=False, exist_ok=False)
            self._jobs[job_id] = job
            self._queued_slots += 1
            self._persist(job)
            self._queue.put_nowait(job_id)
            return self._copy(job)

    async def get(self, job_id: str) -> JobRecord | None:
        async with self._lock:
            job = self._jobs.get(job_id)
            return self._copy(job) if job else None

    async def list(self, limit: int = 50) -> list[JobRecord]:
        async with self._lock:
            records = sorted(
                self._jobs.values(), key=lambda job: job.created_at, reverse=True
            )[:limit]
            return [self._copy(job) for job in records]

    async def cancel(self, job_id: str) -> JobRecord | None:
        process: asyncio.subprocess.Process | None = None
        should_purge = False
        async with self._lock:
            job = self._jobs.get(job_id)
            if not job:
                return None
            if job.status == "expired":
                return self._copy(job)
            if job.queue_slot_held:
                self._queued_slots = max(0, self._queued_slots - 1)
                job.queue_slot_held = False
            process = job.process
            preserve_failure = job.status == "failed" or (
                job.status in {"queued", "running"} and job.error is not None
            )
            job.status = "failed" if preserve_failure else "cancelled"
            if not preserve_failure:
                job.error = None
            self._clear_artifact(job)
            job.updated_at = time.time()
            self._persist(job)
            should_purge = True
            snapshot = self._copy(job)
        if process and process.returncode is None:
            await self._terminate_process(process)
        if should_purge:
            self._purge_work_files(job_id)
        return snapshot

    async def health(self) -> dict[str, int]:
        async with self._lock:
            return {
                "queued": sum(job.status == "queued" for job in self._jobs.values()),
                "running": sum(job.status == "running" for job in self._jobs.values()),
                "queueCapacity": self.settings.max_queued,
                "concurrency": self.settings.concurrency,
            }

    async def _consumer(self, worker_index: int) -> None:
        del worker_index
        while True:
            job_id = await self._queue.get()
            try:
                async with self._lock:
                    job = self._jobs.get(job_id)
                    if not job:
                        continue
                    if job.queue_slot_held:
                        self._queued_slots = max(0, self._queued_slots - 1)
                        job.queue_slot_held = False
                    if job.status != "queued":
                        continue
                    job.status = "running"
                    job.phase = "resolving"
                    job.progress = 0.01
                    job.updated_at = time.time()
                    self._persist(job)
                await self._run_worker(job_id)
            except asyncio.CancelledError:
                raise
            except Exception:
                LOGGER.exception("unhandled consumer error for job %s", job_id)
                await self._fail_job(
                    job_id,
                    JobError("INTERNAL_ERROR", "下载服务发生内部错误。", True),
                )
            finally:
                self._queue.task_done()

    def _worker_command(self, job_id: str, bvid: str) -> list[str]:
        return [
            sys.executable,
            *WORKER_PYTHON_OPTIONS,
            str(self._worker_script),
            "--state-root",
            str(self.settings.state_root),
            "--job-id",
            job_id,
            "--bvid",
            bvid,
            "--max-duration",
            str(self.settings.max_duration_seconds),
            "--max-bytes",
            str(self.settings.max_bytes),
        ]

    async def _run_worker(self, job_id: str) -> None:
        async with self._lock:
            job = self._jobs.get(job_id)
            if not job or job.status != "running":
                return
            bvid = job.bvid

        command = self._worker_command(job_id, bvid)
        environment = self._worker_environment()
        process_options: dict[str, Any] = {}
        if os.name == "nt":
            process_options["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP
        else:
            process_options["start_new_session"] = True
        try:
            process = await asyncio.create_subprocess_exec(
                *command,
                stdin=asyncio.subprocess.DEVNULL,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                cwd=str(self._worker_script.parent),
                env=environment,
                **process_options,
            )
        except OSError:
            LOGGER.exception("failed to start download worker")
            await self._fail_job(
                job_id,
                JobError("WORKER_START_FAILED", "无法启动下载进程。", True),
            )
            return

        purge_failed_files = False
        async with self._lock:
            current = self._jobs.get(job_id)
            if not current or current.status == "cancelled":
                await self._terminate_process(process)
                return
            current.process = process

        stderr_chunks: list[bytes] = []
        stdout_task = asyncio.create_task(
            self._consume_stdout(job_id, process.stdout),
            name=f"stdout-{job_id}",
        )
        stderr_task = asyncio.create_task(
            self._consume_stderr(process.stderr, stderr_chunks),
            name=f"stderr-{job_id}",
        )
        timed_out = False
        try:
            await asyncio.wait_for(
                process.wait(), timeout=self.settings.job_timeout_seconds
            )
        except asyncio.TimeoutError:
            timed_out = True
            await self._terminate_process(process)
        except asyncio.CancelledError:
            await self._terminate_process(process)
            raise
        finally:
            _, pending_streams = await asyncio.wait(
                (stdout_task, stderr_task), timeout=5
            )
            for task in pending_streams:
                task.cancel()
            await asyncio.gather(stdout_task, stderr_task, return_exceptions=True)

        stderr_tail = b"".join(stderr_chunks)[-8_192:].decode("utf-8", "replace")
        if process.returncode not in {0, None} and stderr_tail:
            LOGGER.warning("worker %s exited %s: %s", job_id, process.returncode, stderr_tail)

        async with self._lock:
            current = self._jobs.get(job_id)
            if current:
                current.process = None
            if not current or current.status == "cancelled":
                return
            if current.error:
                current.status = "failed"
                current.updated_at = time.time()
                self._clear_artifact(current)
                self._persist(current)
                purge_failed_files = True
            elif timed_out:
                self._set_failed(
                    current,
                    JobError("TIMEOUT", "下载任务超时，请稍后重试。", True),
                )
                purge_failed_files = True
            elif process.returncode == 0 and self._artifact_is_valid(current):
                current.status = "succeeded"
                current.phase = "ready"
                current.progress = 1.0
                current.error = None
                current.artifact_expires_at = (
                    time.time() + self.settings.artifact_ttl_seconds
                )
                current.updated_at = time.time()
                self._persist(current)
            else:
                self._set_failed(
                    current,
                    JobError("WORKER_FAILED", "视频下载失败，请稍后重试。", True),
                )
                purge_failed_files = True
        if purge_failed_files:
            self._purge_work_files(job_id)

    async def _consume_stdout(
        self, job_id: str, stream: asyncio.StreamReader | None
    ) -> None:
        if stream is None:
            return
        messages = 0
        while True:
            line = await stream.readline()
            if not line:
                return
            messages += 1
            if messages > 20_000 or len(line) > 32_768:
                LOGGER.warning("worker protocol limit exceeded for %s", job_id)
                return
            try:
                payload = json.loads(line)
            except (UnicodeDecodeError, json.JSONDecodeError):
                LOGGER.warning("ignored malformed worker output for %s", job_id)
                continue
            if isinstance(payload, dict):
                await self._handle_worker_message(job_id, payload)

    @staticmethod
    async def _consume_stderr(
        stream: asyncio.StreamReader | None, chunks: list[bytes]
    ) -> None:
        if stream is None:
            return
        total = 0
        while True:
            chunk = await stream.read(2_048)
            if not chunk:
                return
            chunks.append(chunk)
            total += len(chunk)
            while total > 8_192 and chunks:
                total -= len(chunks.pop(0))

    async def _handle_worker_message(
        self, job_id: str, payload: dict[str, Any]
    ) -> None:
        event = payload.get("event")
        async with self._lock:
            job = self._jobs.get(job_id)
            if not job or job.status != "running":
                return
            if event == "source":
                title = payload.get("title")
                duration = payload.get("durationSeconds")
                if isinstance(title, str):
                    job.title = title.strip()[:300] or None
                if isinstance(duration, (int, float)) and math.isfinite(duration):
                    job.duration_seconds = round(float(duration), 3)
            elif event == "progress":
                phase = payload.get("phase")
                progress = payload.get("progress")
                if phase in VALID_PHASES and PHASE_ORDER[phase] >= PHASE_ORDER[job.phase]:
                    job.phase = phase
                if isinstance(progress, (int, float)) and math.isfinite(progress):
                    job.progress = max(job.progress, min(0.99, max(0.0, float(progress))))
            elif event == "artifact":
                artifact_file = payload.get("artifactFile")
                filename = payload.get("filename")
                mime_type = payload.get("mimeType")
                size = payload.get("sizeBytes")
                sha256 = payload.get("sha256")
                if (
                    isinstance(artifact_file, str)
                    and artifact_file == Path(artifact_file).name
                    and isinstance(filename, str)
                    and 0 < len(filename) <= 240
                    and isinstance(mime_type, str)
                    and mime_type.startswith("video/")
                    and isinstance(size, int)
                    and 0 < size <= self.settings.max_bytes
                    and isinstance(sha256, str)
                    and len(sha256) == 64
                    and all(char in "0123456789abcdef" for char in sha256)
                ):
                    job.artifact_file = artifact_file
                    job.artifact_filename = filename
                    job.artifact_mime_type = mime_type
                    job.artifact_size_bytes = size
                    job.artifact_sha256 = sha256
                    job.phase = "ready"
                    job.progress = 0.99
            elif event == "error":
                code = payload.get("code")
                message = payload.get("message")
                retryable = payload.get("retryable")
                if (
                    isinstance(code, str)
                    and 1 <= len(code) <= 64
                    and code.replace("_", "").isalnum()
                    and isinstance(message, str)
                    and isinstance(retryable, bool)
                ):
                    job.status = "failed"
                    job.error = JobError(code, message[:300], retryable)
                    self._clear_artifact(job)
            job.updated_at = time.time()
            self._persist(job)

    async def _fail_job(self, job_id: str, error: JobError) -> None:
        should_purge = False
        async with self._lock:
            job = self._jobs.get(job_id)
            if job and job.status not in {"cancelled", "expired"}:
                self._set_failed(job, error)
                should_purge = True
        if should_purge:
            self._purge_work_files(job_id)

    def _set_failed(self, job: JobRecord, error: JobError) -> None:
        job.status = "failed"
        if job.error is None:
            job.error = error
        job.updated_at = time.time()
        self._clear_artifact(job)
        self._persist(job)

    def _artifact_is_valid(self, job: JobRecord) -> bool:
        if not all(
            (
                job.artifact_file,
                job.artifact_filename,
                job.artifact_mime_type,
                job.artifact_size_bytes,
                job.artifact_sha256,
            )
        ):
            return False
        try:
            job_dir = safe_job_dir(self.settings.state_root, job.job_id)
            artifact = safe_artifact_path(job_dir, job.artifact_file or "")
            stat = artifact.stat()
        except (OSError, ValueError):
            return False
        return (
            artifact.is_file()
            and not artifact.is_symlink()
            and stat.st_size == job.artifact_size_bytes
            and stat.st_size <= self.settings.max_bytes
        )

    async def _load_records(self) -> None:
        now = time.time()
        purge_ids: list[str] = []
        for entry in self.settings.state_root.iterdir():
            if not entry.is_dir() or not is_valid_job_id(entry.name):
                continue
            metadata = entry / "job.json"
            try:
                if metadata.stat().st_size > 64 * 1024:
                    raise ValueError("metadata too large")
                raw = json.loads(metadata.read_text(encoding="utf-8"))
                job = JobRecord.from_disk(raw)
                if job.job_id != entry.name or not is_valid_bvid(job.bvid):
                    raise ValueError("invalid persisted job")
                if job.status not in {
                    "queued", "running", "succeeded", "failed", "cancelled", "expired"
                } or job.phase not in VALID_PHASES:
                    raise ValueError("invalid persisted state")
                if job.status in {"queued", "running"}:
                    job.status = "failed"
                    job.queue_slot_held = False
                    if job.error is None:
                        job.error = JobError(
                            "SERVICE_RESTARTED", "服务重启中断了下载，请重新提交。", True
                        )
                    job.updated_at = now
                elif job.status == "succeeded" and (
                    not job.artifact_expires_at
                    or job.artifact_expires_at <= now
                    or not self._artifact_is_valid(job)
                ):
                    job.status = "expired"
                    job.queue_slot_held = False
                    self._clear_artifact(job)
                    job.updated_at = now
                else:
                    job.queue_slot_held = False
                self._jobs[job.job_id] = job
                self._persist(job)
                if job.status != "succeeded":
                    purge_ids.append(job.job_id)
            except (OSError, ValueError, TypeError, KeyError, json.JSONDecodeError):
                LOGGER.warning("ignored invalid persisted job directory %s", entry.name)
        for job_id in purge_ids:
            self._purge_work_files(job_id)

    async def _cleanup_loop(self) -> None:
        while True:
            try:
                await asyncio.sleep(self.settings.cleanup_interval_seconds)
                await self.cleanup_once()
            except asyncio.CancelledError:
                raise
            except Exception:
                LOGGER.exception("media cleanup failed")

    async def cleanup_once(self) -> None:
        now = time.time()
        purge_ids: list[str] = []
        remove_ids: list[str] = []
        async with self._lock:
            for job_id, job in list(self._jobs.items()):
                if (
                    job.status == "succeeded"
                    and job.artifact_expires_at
                    and job.artifact_expires_at <= now
                ):
                    job.status = "expired"
                    job.updated_at = now
                    self._clear_artifact(job)
                    self._persist(job)
                    purge_ids.append(job_id)
                elif job.status in {"failed", "cancelled"} and (
                    now - job.updated_at >= self.settings.terminal_retention_seconds
                ):
                    job.status = "expired"
                    job.updated_at = now
                    self._clear_artifact(job)
                    self._persist(job)
                    purge_ids.append(job_id)
                elif job.status == "expired" and (
                    now - job.updated_at >= self.settings.terminal_retention_seconds
                ):
                    remove_ids.append(job_id)
                    self._jobs.pop(job_id, None)
        for job_id in purge_ids:
            self._purge_work_files(job_id)
        for job_id in remove_ids:
            self._remove_job_dir(job_id)
        self._remove_untracked_stale_dirs(now)

    def _persist(self, job: JobRecord) -> None:
        try:
            job_dir = safe_job_dir(self.settings.state_root, job.job_id)
            job_dir.mkdir(parents=True, exist_ok=True)
            destination = job_dir / "job.json"
            temporary = job_dir / "job.json.tmp"
            temporary.write_text(
                json.dumps(job.to_disk(), ensure_ascii=False, separators=(",", ":")),
                encoding="utf-8",
            )
            os.replace(temporary, destination)
        except OSError:
            LOGGER.exception("failed to persist job %s", job.job_id)

    def _purge_work_files(self, job_id: str) -> None:
        try:
            job_dir = safe_job_dir(self.settings.state_root, job_id)
            if not job_dir.is_dir():
                return
            for child in job_dir.iterdir():
                if child.name in {"job.json", "job.json.tmp"}:
                    continue
                if child.is_dir() and not child.is_symlink():
                    shutil.rmtree(child)
                else:
                    child.unlink(missing_ok=True)
        except OSError:
            LOGGER.exception("failed to purge files for job %s", job_id)

    def _remove_job_dir(self, job_id: str) -> None:
        try:
            job_dir = safe_job_dir(self.settings.state_root, job_id)
            if job_dir.is_dir():
                shutil.rmtree(job_dir)
        except OSError:
            LOGGER.exception("failed to remove job directory %s", job_id)

    def _remove_untracked_stale_dirs(self, now: float) -> None:
        tracked = set(self._jobs)
        try:
            entries = list(self.settings.state_root.iterdir())
        except OSError:
            return
        for entry in entries:
            if (
                not entry.is_dir()
                or entry.name in tracked
                or not is_valid_job_id(entry.name)
            ):
                continue
            try:
                if now - entry.stat().st_mtime >= self.settings.terminal_retention_seconds:
                    self._remove_job_dir(entry.name)
            except OSError:
                continue

    @staticmethod
    async def _terminate_process(process: asyncio.subprocess.Process) -> None:
        if process.returncode is not None:
            return
        if os.name == "nt":
            tree_kill: asyncio.subprocess.Process | None = None
            try:
                tree_kill = await asyncio.create_subprocess_exec(
                    "taskkill",
                    "/PID",
                    str(process.pid),
                    "/T",
                    "/F",
                    stdin=asyncio.subprocess.DEVNULL,
                    stdout=asyncio.subprocess.DEVNULL,
                    stderr=asyncio.subprocess.DEVNULL,
                )
                await asyncio.wait_for(tree_kill.wait(), timeout=5)
            except (OSError, asyncio.TimeoutError):
                if tree_kill and tree_kill.returncode is None:
                    tree_kill.kill()
                    await asyncio.gather(tree_kill.wait(), return_exceptions=True)
            if tree_kill is None or tree_kill.returncode != 0:
                try:
                    process.kill()
                except ProcessLookupError:
                    pass
            try:
                await asyncio.wait_for(process.wait(), timeout=5)
            except asyncio.TimeoutError:
                try:
                    process.kill()
                except ProcessLookupError:
                    pass
                try:
                    await asyncio.wait_for(process.wait(), timeout=5)
                except asyncio.TimeoutError:
                    LOGGER.warning("worker process %s did not exit after taskkill", process.pid)
            return

        try:
            os.killpg(process.pid, signal.SIGTERM)
        except ProcessLookupError:
            try:
                await asyncio.wait_for(process.wait(), timeout=1)
            except asyncio.TimeoutError:
                try:
                    process.kill()
                except ProcessLookupError:
                    pass
                try:
                    await asyncio.wait_for(process.wait(), timeout=5)
                except asyncio.TimeoutError:
                    LOGGER.warning("worker process %s could not be reaped", process.pid)
            return

        try:
            await asyncio.wait_for(process.wait(), timeout=5)
        except asyncio.TimeoutError:
            pass

        # The worker may exit before a child such as FFmpeg. Check the process
        # group even when the parent has already completed, then force-kill any
        # remaining descendants so their inherited pipes cannot hang cleanup.
        try:
            os.killpg(process.pid, 0)
        except ProcessLookupError:
            group_exists = False
        except PermissionError:
            group_exists = True
        else:
            group_exists = True
        if group_exists:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        if process.returncode is None:
            try:
                await asyncio.wait_for(process.wait(), timeout=5)
            except asyncio.TimeoutError:
                LOGGER.warning("worker process group %s did not exit after SIGKILL", process.pid)

    @staticmethod
    def _worker_environment() -> dict[str, str]:
        allowed = {
            "PATH",
            "PATHEXT",
            "SYSTEMROOT",
            "WINDIR",
            "SSL_CERT_FILE",
            "REQUESTS_CA_BUNDLE",
            "LANG",
            "LC_ALL",
            "TZ",
        }
        environment = {
            key: value for key, value in os.environ.items() if key.upper() in allowed
        }
        environment["PYTHONUNBUFFERED"] = "1"
        environment["PYTHONIOENCODING"] = "utf-8"
        environment["PYTHONUTF8"] = "1"
        return environment

    @staticmethod
    def _copy(job: JobRecord) -> JobRecord:
        error = replace(job.error) if job.error else None
        return replace(job, error=error, process=None)

    @staticmethod
    def _clear_artifact(job: JobRecord) -> None:
        job.artifact_file = None
        job.artifact_filename = None
        job.artifact_mime_type = None
        job.artifact_size_bytes = None
        job.artifact_sha256 = None
        job.artifact_expires_at = None
