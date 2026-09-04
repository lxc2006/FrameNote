$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$releaseRoot = Join-Path $projectRoot "release"
$unpackedRoot = Join-Path $releaseRoot "win-unpacked"
$coreRoot = Join-Path $unpackedRoot "resources\media-sidecar\framenote-media-core"
$coreExecutable = Join-Path $coreRoot "framenote-media-core.exe"

$installer = Get-ChildItem -LiteralPath $releaseRoot -File -Filter "FrameNote-Setup-*-x64.exe" |
  Sort-Object LastWriteTimeUtc -Descending |
  Select-Object -First 1
if (-not $installer) { throw "FrameNote NSIS installer was not found." }
$installerSizeMb = $installer.Length / 1MB
if ($installerSizeMb -gt 750) {
  throw ("Base installer size {0:N1} MB exceeds the 750 MB target." -f $installerSizeMb)
}
if ($installerSizeMb -lt 450) {
  Write-Output ("Base installer is {0:N1} MB, below the original 450-750 MB estimate." -f $installerSizeMb)
}
if (-not (Test-Path -LiteralPath $coreExecutable -PathType Leaf)) {
  throw "Packaged media core executable is missing."
}
$forbiddenNames = "funasr|modelscope|torch|torchaudio|torchvision|transformers|ct-punc|fun-asr-nano"
$forbidden = Get-ChildItem -LiteralPath $unpackedRoot -Recurse -Force | Where-Object {
  $_.FullName -match $forbiddenNames -or $_.Extension -in ".onnx", ".pt", ".pth", ".safetensors"
}
if ($forbidden) {
  throw "Base installer contains subtitle extension packages or model files."
}
$environmentFiles = Get-ChildItem -LiteralPath $unpackedRoot -Recurse -Force -File | Where-Object {
  $_.Name -like ".env*"
}
if ($environmentFiles) { throw "Packaged application contains an environment file." }
$updateMetadata = Join-Path $releaseRoot "latest.yml"
if (-not (Test-Path -LiteralPath $updateMetadata -PathType Leaf)) {
  throw "Auto-update metadata latest.yml is missing."
}

[pscustomobject]@{
  Installer = $installer.FullName
  InstallerMB = [math]::Round($installerSizeMb, 1)
  MediaCore = $coreExecutable
  SubtitleFilesInBase = 0
  UpdateMetadata = $updateMetadata
} | Format-List
