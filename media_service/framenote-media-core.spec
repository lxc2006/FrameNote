# -*- mode: python ; coding: utf-8 -*-

from pathlib import Path
import shutil
import sys

from PyInstaller.utils.hooks import (
    collect_all,
    collect_data_files,
    collect_submodules,
)

tld_data = collect_data_files("tld")
trafilatura_data = collect_data_files("trafilatura")
justext_data = collect_data_files("justext")


project_root = Path(SPECPATH).resolve().parent
entry_point = project_root / "media_service" / "core_entry.py"
runtime_hook = project_root / "media_service" / "pyinstaller" / "runtime_core.py"

ffmpeg = shutil.which("ffmpeg")
ffprobe = shutil.which("ffprobe")
if not ffmpeg or not ffprobe:
    raise RuntimeError("ffmpeg and ffprobe must be available on PATH")

runtime_binaries = []
for runtime_name in (
    "ffi.dll",
    "libcrypto-3-x64.dll",
    "libmpdec-4.dll",
    "libssl-3-x64.dll",
    "sqlite3.dll",
):
    for runtime_directory in (
        Path(sys.base_prefix) / "Library" / "bin",
        Path(sys.base_prefix) / "DLLs",
    ):
        runtime_file = runtime_directory / runtime_name
        if runtime_file.is_file():
            runtime_binaries.append((str(runtime_file), "."))
            break

yt_dlp_data, yt_dlp_binaries, yt_dlp_hiddenimports = collect_all("yt_dlp")
hiddenimports = sorted(
    set(
        yt_dlp_hiddenimports
        + collect_submodules("uvicorn")
        + collect_submodules("scenedetect")
        + [
            "cv2",
            "imagehash",
            "media_service.analysis_pipeline",
            "media_service.bilibili_retry",
            "media_service.bilibili_preview",
            "media_service.bilibili_preview_proxy",
            "media_service.service.config",
            "media_service.service.job_manager",
            "media_service.service.models",
            "media_service.service.security",
            "media_service.web_extract",
            "media_service.worker",
            "multipart",
            "numpy",
            "PIL",
            "pydantic",
            "pypdf",
            "trafilatura",
        ]
    )
)

analysis = Analysis(
    [str(entry_point)],
    pathex=[str(project_root)],
    binaries=(
        yt_dlp_binaries
        + runtime_binaries
        + [(ffmpeg, "."), (ffprobe, ".")]
    ),
    datas=yt_dlp_data + tld_data + trafilatura_data + justext_data, 
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[str(runtime_hook)],
    excludes=[],
    noarchive=False,
    optimize=1,
)
pyz = PYZ(analysis.pure)

exe = EXE(
    pyz,
    analysis.scripts,
    [],
    exclude_binaries=True,
    name="framenote-media-core",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    contents_directory=".",
)
distribution = COLLECT(
    exe,
    analysis.binaries,
    analysis.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name="framenote-media-core",
)
