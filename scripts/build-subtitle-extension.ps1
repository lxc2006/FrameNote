param(
  [string]$PythonExecutable = "",
  [string]$Version = "1.0.0",
  [string]$ModelScopeRoot = "",
  [switch]$ReuseDistribution,
  [switch]$SkipArchive
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$mediaRoot = Join-Path $projectRoot "media_service"
$buildEnvironment = Join-Path $mediaRoot ".venv-subtitles"
$buildPython = Join-Path $buildEnvironment "Scripts\python.exe"
$releaseRoot = Join-Path $projectRoot "release"
$distribution = Join-Path $mediaRoot "dist\framenote-subtitles"
$executable = Join-Path $distribution "framenote-subtitles.exe"
$modelsRoot = Join-Path $distribution "models"

function Get-Sha256Hex([string]$Path) {
  $stream = [IO.File]::OpenRead($Path)
  try {
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try {
      return ([BitConverter]::ToString($algorithm.ComputeHash($stream))).Replace("-", "").ToLowerInvariant()
    } finally {
      $algorithm.Dispose()
    }
  } finally {
    $stream.Dispose()
  }
}

if ($Version -notmatch '^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$') {
  throw "Subtitle extension version must be semantic version text."
}
if (-not $PythonExecutable) {
  $projectPython = Join-Path $projectRoot ".venv\Scripts\python.exe"
  $PythonExecutable = if (Test-Path -LiteralPath $projectPython) {
    $projectPython
  } else {
    (Get-Command python -ErrorAction Stop).Source
  }
}
if (-not $ModelScopeRoot) {
  $ModelScopeRoot = Join-Path $env:USERPROFILE ".cache\modelscope\models"
}

$modelSources = [ordered]@{
  "fun-asr-nano" = Join-Path $ModelScopeRoot "FunAudioLLM--Fun-ASR-Nano-2512\snapshots\master"
  "fsmn-vad" = Join-Path $ModelScopeRoot "iic--speech_fsmn_vad_zh-cn-16k-common-pytorch\snapshots\master"
  "ct-punc" = Join-Path $ModelScopeRoot "iic--punc_ct-transformer_cn-en-common-vocab471067-large\snapshots\master"
}
foreach ($entry in $modelSources.GetEnumerator()) {
  if (-not (Test-Path -LiteralPath $entry.Value -PathType Container)) {
    throw "Required subtitle model is missing: $($entry.Key) at $($entry.Value)"
  }
}

if (-not $ReuseDistribution) {
  if (-not (Test-Path -LiteralPath $buildPython)) {
    & $PythonExecutable -m venv $buildEnvironment
    if ($LASTEXITCODE -ne 0) { throw "Failed to create subtitle build environment." }
  }
  & $buildPython -m pip install --disable-pip-version-check -r (Join-Path $mediaRoot "requirements-build-subtitles.txt")
  if ($LASTEXITCODE -ne 0) { throw "Failed to install subtitle build dependencies." }

  & $buildPython -m PyInstaller --noconfirm --clean --distpath (Join-Path $mediaRoot "dist") --workpath (Join-Path $mediaRoot "build-subtitles") (Join-Path $mediaRoot "framenote-subtitles.spec")
  if ($LASTEXITCODE -ne 0) { throw "Failed to build framenote-subtitles." }

  if (-not (Test-Path -LiteralPath $executable -PathType Leaf)) {
    throw "The build did not produce framenote-subtitles.exe."
  }
  New-Item -ItemType Directory -Path $modelsRoot -Force | Out-Null
  foreach ($entry in $modelSources.GetEnumerator()) {
    $destination = Join-Path $modelsRoot $entry.Key
    if (Test-Path -LiteralPath $destination) {
      Remove-Item -LiteralPath $destination -Recurse -Force
    }
    Copy-Item -LiteralPath $entry.Value -Destination $destination -Recurse
  }
} elseif (-not (Test-Path -LiteralPath $executable -PathType Leaf)) {
  throw "Cannot reuse subtitle distribution because its executable is missing."
} else {
  foreach ($entry in $modelSources.GetEnumerator()) {
    if (-not (Test-Path -LiteralPath (Join-Path $modelsRoot $entry.Key) -PathType Container)) {
      throw "Cannot reuse subtitle distribution because model $($entry.Key) is missing."
    }
  }
}

$descriptor = [ordered]@{
  schemaVersion = 1
  id = "framenote-subtitles"
  version = $Version
  executable = "framenote-subtitles.exe"
  models = @("fun-asr-nano", "fsmn-vad", "ct-punc")
}
$descriptorPath = Join-Path $distribution "extension.json"
[IO.File]::WriteAllText(
  $descriptorPath,
  ($descriptor | ConvertTo-Json -Depth 4),
  [Text.UTF8Encoding]::new($false)
)

& $executable --health
if ($LASTEXITCODE -ne 0) { throw "Subtitle extension health check failed." }
$unpackedSize = (Get-ChildItem -LiteralPath $distribution -Recurse -File | Measure-Object Length -Sum).Sum
Write-Output ("Subtitle extension unpacked size: {0:N2} GB" -f ($unpackedSize / 1GB))
if ($SkipArchive) {
  Write-Output "Archive generation skipped."
  exit 0
}

New-Item -ItemType Directory -Path $releaseRoot -Force | Out-Null
$archiveName = "FrameNote-Subtitles-$Version-win-x64.zip"
$archivePath = Join-Path $releaseRoot $archiveName
if (Test-Path -LiteralPath $archivePath) {
  Remove-Item -LiteralPath $archivePath -Force
}
& tar.exe -a -cf $archivePath -C $distribution .
if ($LASTEXITCODE -ne 0) { throw "Failed to create subtitle extension archive." }
$archiveSize = (Get-Item -LiteralPath $archivePath).Length
$archiveSha256 = Get-Sha256Hex $archivePath
$manifest = [ordered]@{
  schemaVersion = 1
  id = "framenote-subtitles"
  version = $Version
  minimumAppVersion = "0.1.0"
  archiveUrl = "https://github.com/lxc2006/FrameNote/releases/download/subtitles-v$Version/$archiveName"
  sha256 = $archiveSha256
  downloadBytes = $archiveSize
  unpackedBytes = $unpackedSize
}
$manifestPath = Join-Path $releaseRoot "framenote-subtitles-manifest.json"
[IO.File]::WriteAllText(
  $manifestPath,
  ($manifest | ConvertTo-Json -Depth 4),
  [Text.UTF8Encoding]::new($false)
)
Write-Output "Built: $archivePath"
Write-Output ("Subtitle extension download size: {0:N2} GB" -f ($archiveSize / 1GB))
Write-Output "Manifest: $manifestPath"
