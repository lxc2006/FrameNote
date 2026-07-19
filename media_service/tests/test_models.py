from __future__ import annotations

import unittest

from media_service.service.models import (
    ErrorResponse,
    JobResponse,
    SourceResponse,
)


class JobResponseTests(unittest.TestCase):
    def test_failed_job_serializes_structured_error(self) -> None:
        response = JobResponse(
            jobId="01111111-1111-4111-8111-111111111111",
            status="failed",
            phase="downloading",
            progress=0.42,
            source=SourceResponse(bvid="BV1xx411c7mD"),
            error=ErrorResponse(
                code="DOWNLOAD_FAILED",
                message="下载失败🧪",
                retryable=True,
            ),
        )

        payload = response.model_dump(mode="json", exclude_none=True)

        self.assertEqual(payload["status"], "failed")
        self.assertEqual(
            payload["error"],
            {
                "code": "DOWNLOAD_FAILED",
                "message": "下载失败🧪",
                "retryable": True,
            },
        )


if __name__ == "__main__":
    unittest.main()
