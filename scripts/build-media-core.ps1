param(
  [string]$PythonExecutable = ""
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$mediaRoot = Join-Path $projectRoot "media_service"
$buildEnvironment = Join-Path $mediaRoot ".venv-core"
$buildPython = Join-Path $buildEnvironment "Scripts\python.exe"

if (-not $PythonExecutable) {
  $projectPython = Join-Path $projectRoot ".venv\Scripts\python.exe"
  $PythonExecutable = if (Test-Path -LiteralPath $projectPython) {
    $projectPython
  } else {
    (Get-Command python -ErrorAction Stop).Source
  }
}

if (-not (Test-Path -LiteralPath $buildPython)) {
  & $PythonExecutable -m venv $buildEnvironment
  if ($LASTEXITCODE -ne 0) { throw "Failed to create the media core build environment." }
}

& $buildPython -m pip install --disable-pip-version-check -r (Join-Path $mediaRoot "requirements-build-core.txt")
if ($LASTEXITCODE -ne 0) { throw "Failed to install media core dependencies." }

& $buildPython -m PyInstaller --noconfirm --clean --distpath (Join-Path $mediaRoot "dist") --workpath (Join-Path $mediaRoot "build") (Join-Path $mediaRoot "framenote-media-core.spec")
if ($LASTEXITCODE -ne 0) { throw "Failed to build framenote-media-core." }

$distribution = Join-Path $mediaRoot "dist\framenote-media-core"
$executable = Join-Path $distribution "framenote-media-core.exe"
if (-not (Test-Path -LiteralPath $executable)) {
  throw "The build did not produce framenote-media-core.exe."
}

$forbiddenNames = "funasr|modelscope|torch|torchaudio|torchvision|transformers|ct-punc|fun-asr-nano"
$forbiddenFiles = Get-ChildItem -LiteralPath $distribution -Recurse -Force | Where-Object {
  $_.FullName -match $forbiddenNames -or $_.Extension -in ".onnx", ".pt", ".pth", ".safetensors"
}
if ($forbiddenFiles) {
  $paths = ($forbiddenFiles | Select-Object -ExpandProperty FullName) -join [Environment]::NewLine
  throw "The core package contains forbidden local speech-model files:$([Environment]::NewLine)$paths"
}

$archiveViewer = Join-Path $buildEnvironment "Scripts\pyi-archive_viewer.exe"
$archiveListing = & $archiveViewer --recursive --brief $executable 2>&1
if ($LASTEXITCODE -ne 0) {
  throw "Failed to inspect the PyInstaller archive."
}
$forbiddenArchiveModules = "(?im)^\s*(funasr|huggingface_hub|media_service\.transcription_funasr|modelscope|tiktoken|torch|torchaudio|torchvision|transformers)(?:[.\\/]|$)"
if (($archiveListing -join [Environment]::NewLine) -match $forbiddenArchiveModules) {
  throw "The core executable contains a forbidden local speech-model module."
}

$size = (Get-ChildItem -LiteralPath $distribution -Recurse -File | Measure-Object -Property Length -Sum).Sum
Write-Output "Built: $executable"
Write-Output ("Core onedir size: {0:N1} MB" -f ($size / 1MB))
Write-Output "Verified: the media core contains no local speech-recognition runtime or model files."
