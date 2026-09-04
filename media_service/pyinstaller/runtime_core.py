"""Runtime initialization kept intentionally free of subtitle dependencies."""

from __future__ import annotations

import os
import sys
from pathlib import Path


bundle_root = Path(sys.executable).resolve().parent
os.environ["PATH"] = os.pathsep.join(
    item for item in (str(bundle_root), os.environ.get("PATH", "")) if item
)
