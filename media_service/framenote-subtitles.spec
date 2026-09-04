# -*- mode: python ; coding: utf-8 -*-

from pathlib import Path

from PyInstaller.utils.hooks import collect_all


project_root = Path(SPECPATH).resolve().parent
entry_point = project_root / "media_service" / "transcription_extension_entry.py"

datas = []
binaries = []
hiddenimports = [
    "media_service.analysis_pipeline",
    "media_service.transcription_funasr",
]
for package in (
    "funasr",
    "huggingface_hub",
    "modelscope",
    "tiktoken",
    "torch",
    "torchaudio",
    "transformers",
):
    package_datas, package_binaries, package_hiddenimports = collect_all(package)
    datas += package_datas
    binaries += package_binaries
    hiddenimports += package_hiddenimports

analysis = Analysis(
    [str(entry_point)],
    pathex=[str(project_root)],
    binaries=binaries,
    datas=datas,
    hiddenimports=sorted(set(hiddenimports)),
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=["fastapi", "scenedetect", "trafilatura", "uvicorn", "yt_dlp"],
    noarchive=False,
    optimize=1,
)
pyz = PYZ(analysis.pure)

exe = EXE(
    pyz,
    analysis.scripts,
    [],
    exclude_binaries=True,
    name="framenote-subtitles",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=True,
    disable_windowed_traceback=False,
)
distribution = COLLECT(
    exe,
    analysis.binaries,
    analysis.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name="framenote-subtitles",
)
