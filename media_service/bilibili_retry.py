from __future__ import annotations

import time
from collections.abc import Callable
from typing import TypeVar


BILIBILI_RESOLVE_ATTEMPTS = 5
_Result = TypeVar("_Result")


def bilibili_retry_delay_seconds(failed_attempt: int) -> float:
    """Use bounded backoff so a 412 is not made worse by immediate retries."""
    return 2.0


def resolve_bilibili_with_retries(
    operation: Callable[[], _Result],
    retry_errors: tuple[type[BaseException], ...],
    *,
    on_retry: Callable[[int, int, float, BaseException], None] | None = None,
    sleep: Callable[[float], None] = time.sleep,
) -> _Result:
    """Run one complete Bilibili resolution up to five times.

    The fifth failure is re-raised to the caller, which is the only place that
    reports an error. Intermediate failures stay inside the retry loop.
    """
    for attempt in range(1, BILIBILI_RESOLVE_ATTEMPTS + 1):
        try:
            return operation()
        except retry_errors as error:
            if attempt >= BILIBILI_RESOLVE_ATTEMPTS:
                raise
            delay = bilibili_retry_delay_seconds(attempt)
            if on_retry is not None:
                on_retry(attempt, BILIBILI_RESOLVE_ATTEMPTS, delay, error)
            sleep(delay)
    raise RuntimeError("Bilibili retry loop ended unexpectedly")
