from __future__ import annotations

import unittest

from media_service.service.models import (
    CreateJobRequest,
    ErrorResponse,
    JobResponse,
    SourceResponse,
    WebExtractRequest,
)
from pydantic import ValidationError


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

    def test_direct_summary_threshold_accepts_zero_through_nine_hundred(self) -> None:
        for value in (0, 360, 900):
            request = CreateJobRequest(
                bvid="BV1xx411c7mD",
                variant="analysis",
                directSummaryMaxSeconds=value,
            )
            self.assertEqual(request.directSummaryMaxSeconds, value)

        with self.assertRaises(ValidationError):
            CreateJobRequest(
                bvid="BV1xx411c7mD",
                variant="analysis",
                directSummaryMaxSeconds=901,
            )

    def test_web_extract_request_rejects_extra_fields(self) -> None:
        request = WebExtractRequest(url="https://example.com/article")
        self.assertEqual(request.url, "https://example.com/article")
        with self.assertRaises(ValidationError):
            WebExtractRequest(
                url="https://example.com/article",
                query="unexpected",
            )


if __name__ == "__main__":
    unittest.main()
