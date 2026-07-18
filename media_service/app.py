"""Convenient local entry point: ``python media_service/app.py``."""

from __future__ import annotations

import sys
from pathlib import Path


if __package__ in {None, ""}:
    # Direct script execution places media_service/ rather than the repository
    # root on sys.path. Add the root so the same package imports are used by both
    # this entry point and production uvicorn.
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from media_service.main import app  # noqa: E402


def main() -> None:
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=8788, access_log=False)


if __name__ == "__main__":
    main()
