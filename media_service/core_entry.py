"""PyInstaller entry point for the FrameNote media core sidecar."""

from __future__ import annotations

import os
import sys
from pathlib import Path


def _configure_frozen_runtime() -> None:
    if not getattr(sys, "frozen", False):
        return
    executable_dir = str(Path(sys.executable).resolve().parent)
    current_path = os.environ.get("PATH", "")
    os.environ["PATH"] = os.pathsep.join(
        item for item in (executable_dir, current_path) if item
    )


def _configure_output_streams() -> None:
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if callable(reconfigure):
            reconfigure(encoding="utf-8", errors="backslashreplace")


def main() -> int:
    _configure_frozen_runtime()
    _configure_output_streams()
    arguments = sys.argv[1:]
    if arguments and arguments[0] == "--worker":
        sys.argv = [sys.argv[0], *arguments[1:]]
        from media_service.worker import main as worker_main

        return worker_main()

    from media_service.app import main as service_main

    service_main()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
